#!/usr/bin/env python3
"""Simulation-only multi-agent "desk" that streams structured log events into
the generic hermes-terminal dashboard.

================================  SIMULATION  ================================
This program is a SIMULATION ONLY. It uses NO real-market data, NO real wallet,
NO real funds, and NO autonomous execution. Everything -- the market events, the
fills, and the equity curve -- is synthetic and generated locally from a seeded
random number generator. There is no live mode, no "paper" mode against real
data, no RPC, no private keys, and no trade authorization path. The only run
mode is the synthetic ``sim`` mode (plus an offline ``recap`` reader).
=============================================================================

Architecture: six cooperating agents connected by hard asyncio.Queue handoffs.

    SimSource --> Scout --> Filter --> Analyst --> Executor <--> Risk
                     \\         \\         \\          \\        /
                      '---------- Logger hears everyone --------'

* Scout     -- reads synthetic candidates from SimSource and forwards them.
* Filter    -- drops candidates that fail generic liquidity/age heuristics.
* Analyst   -- scores survivors and decides enter/skip.
* Executor  -- opens and manages synthetic positions via the PaperBroker,
               consulting Risk before every open and on every tick.
* Risk      -- enforces generic exposure / drawdown / position-count limits.
* Logger    -- subscribes to the event bus every agent publishes to, renders
               the stream (plain console or optional rich UI), appends to the
               run's events.jsonl, and forwards every event to hermes-terminal.

Every agent emits structured events with generic fields:
``agent``, ``kind``, ``symbol``, ``reason``, ``data`` (dict). These are posted
to a hermes-terminal channel (default ``desk``) so the whole pipeline streams
live in the dashboard.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
import random
import signal
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from hermes_client import HermesClient

# ---------------------------------------------------------------------------
# Optional rich UI: guarded import so the script runs fully with rich absent.
# ---------------------------------------------------------------------------
try:  # pragma: no cover - exercised implicitly by availability
    from rich.console import Console as _RichConsole  # type: ignore
    from rich.table import Table as _RichTable  # type: ignore

    _RICH_AVAILABLE = True
except Exception:  # noqa: BLE001 - any import failure degrades to plain output
    _RICH_AVAILABLE = False


BANNER = (
    "============================================================\n"
    "  hermes sim-desk  --  SIMULATION ONLY (no real funds)\n"
    "  synthetic market + paper fills + seeded RNG\n"
    "============================================================"
)

RUNS_DIR = Path(__file__).resolve().parent / "runs"

# Levels used by the dashboard color-coding.
INFO = "info"
WARN = "warn"
ERROR = "error"


# ---------------------------------------------------------------------------
# Clock / speed control
# ---------------------------------------------------------------------------
class Clock:
    """A simulation clock with a speed multiplier.

    ``speed`` compresses wall-clock sleeps so a 60-second scenario can be run in
    a few seconds. ``now()`` returns simulated seconds elapsed since start.
    """

    def __init__(self, speed: float = 1.0) -> None:
        self.speed = max(0.01, speed)
        self._start = time.monotonic()

    def now(self) -> float:
        return (time.monotonic() - self._start) * self.speed

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(max(0.0, seconds) / self.speed)


# ---------------------------------------------------------------------------
# Event bus (the "d.log(...)" stream the Logger hears)
# ---------------------------------------------------------------------------
@dataclass
class Event:
    agent: str
    kind: str
    symbol: Optional[str] = None
    reason: Optional[str] = None
    data: Dict[str, Any] = field(default_factory=dict)
    level: Optional[str] = None
    message: Optional[str] = None
    ts: float = field(default_factory=lambda: time.time())

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "agent": self.agent,
            "kind": self.kind,
            "symbol": self.symbol,
            "reason": self.reason,
            "data": self.data,
            "ts": self.ts,
        }
        if self.level is not None:
            d["level"] = self.level
        if self.message is not None:
            d["message"] = self.message
        return d


class Desk:
    """Shared context handed to every agent.

    Holds the event bus queue that the Logger drains. ``log(...)`` is the single
    structured-logging entry point every agent uses (the ``d.log(...)`` stream).
    """

    def __init__(self, clock: Clock) -> None:
        self.clock = clock
        self.bus: "asyncio.Queue[Optional[Event]]" = asyncio.Queue()

    def log(
        self,
        agent: str,
        kind: str,
        symbol: Optional[str] = None,
        reason: Optional[str] = None,
        data: Optional[Dict[str, Any]] = None,
        level: Optional[str] = None,
        message: Optional[str] = None,
    ) -> None:
        self.bus.put_nowait(
            Event(
                agent=agent,
                kind=kind,
                symbol=symbol,
                reason=reason,
                data=data or {},
                level=level,
                message=message,
            )
        )


# ---------------------------------------------------------------------------
# Synthetic market source and paper broker
# ---------------------------------------------------------------------------
@dataclass
class Candidate:
    """A synthetic instrument candidate. All fields are made-up numbers."""

    symbol: str
    token_id: str
    liquidity: float
    age_seconds: float
    momentum: float
    price: float


class SimSource:
    """Generates synthetic candidates from a seeded RNG. No external data."""

    _ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"

    def __init__(self, rng: random.Random) -> None:
        self.rng = rng
        self._counter = 0

    def _symbol(self) -> str:
        self._counter += 1
        letters = "".join(self.rng.choice(self._ALPHABET) for _ in range(3))
        return f"SIM-{letters}{self._counter:03d}"

    def next_candidate(self) -> Candidate:
        symbol = self._symbol()
        return Candidate(
            symbol=symbol,
            token_id=uuid.uuid4().hex[:16],
            liquidity=round(self.rng.uniform(500.0, 50_000.0), 2),
            age_seconds=round(self.rng.uniform(1.0, 600.0), 1),
            momentum=round(self.rng.uniform(-1.0, 1.0), 3),
            price=round(self.rng.uniform(0.01, 5.0), 4),
        )


@dataclass
class Position:
    symbol: str
    token_id: str
    entry_price: float
    size: float
    opened_at: float
    price: float = 0.0

    def __post_init__(self) -> None:
        if not self.price:
            self.price = self.entry_price

    @property
    def pnl(self) -> float:
        return (self.price - self.entry_price) * self.size


class PaperBroker:
    """Executes synthetic (paper) fills against SimSource-style prices only.

    There is no connection to any real venue, wallet, or RPC. Fills are modeled
    with a small synthetic slippage and prices drift via a seeded random walk.
    """

    def __init__(self, rng: random.Random, starting_cash: float = 10_000.0) -> None:
        self.rng = rng
        self.cash = starting_cash
        self.starting_cash = starting_cash
        self.positions: Dict[str, Position] = {}
        self.closed_pnl = 0.0
        self.fills = 0

    def open(self, cand: Candidate, size: float, now: float) -> Position:
        slippage = 1.0 + self.rng.uniform(0.0, 0.01)
        fill_price = round(cand.price * slippage, 6)
        pos = Position(
            symbol=cand.symbol,
            token_id=cand.token_id,
            entry_price=fill_price,
            size=size,
            opened_at=now,
        )
        self.positions[cand.symbol] = pos
        self.cash -= fill_price * size
        self.fills += 1
        return pos

    def mark(self, symbol: str) -> None:
        pos = self.positions.get(symbol)
        if pos is None:
            return
        drift = 1.0 + self.rng.uniform(-0.08, 0.09)
        pos.price = round(max(0.0001, pos.price * drift), 6)

    def close(self, symbol: str) -> Optional[float]:
        pos = self.positions.pop(symbol, None)
        if pos is None:
            return None
        slippage = 1.0 - self.rng.uniform(0.0, 0.01)
        exit_price = round(pos.price * slippage, 6)
        realized = (exit_price - pos.entry_price) * pos.size
        self.cash += exit_price * pos.size
        self.closed_pnl += realized
        return round(realized, 6)

    def equity(self) -> float:
        open_value = sum(p.price * p.size for p in self.positions.values())
        return round(self.cash + open_value, 2)


# ---------------------------------------------------------------------------
# Risk engine (generic exposure / drawdown limits)
# ---------------------------------------------------------------------------
@dataclass
class RiskLimits:
    max_positions: int = 4
    max_position_size: float = 400.0
    max_drawdown: float = 0.25  # fraction of starting equity


class Risk:
    """Enforces generic risk limits. Returns allow/deny with a reason."""

    def __init__(self, broker: PaperBroker, limits: RiskLimits) -> None:
        self.broker = broker
        self.limits = limits
        self.halted = False

    def check_open(self, size: float) -> Dict[str, Any]:
        if self.halted:
            return {"allow": False, "reason": "risk_halt"}
        if len(self.broker.positions) >= self.limits.max_positions:
            return {"allow": False, "reason": "max_positions"}
        if size > self.limits.max_position_size:
            return {"allow": False, "reason": "size_cap"}
        return {"allow": True, "reason": "ok"}

    def check_drawdown(self) -> Dict[str, Any]:
        start = self.broker.starting_cash
        equity = self.broker.equity()
        drawdown = (start - equity) / start if start else 0.0
        if drawdown >= self.limits.max_drawdown:
            self.halted = True
            return {"halt": True, "drawdown": round(drawdown, 4)}
        return {"halt": False, "drawdown": round(drawdown, 4)}


# ---------------------------------------------------------------------------
# The six agents
# ---------------------------------------------------------------------------
class Pipeline:
    """Owns the agents, the hard queue handoffs, and the run lifecycle."""

    def __init__(
        self,
        desk: Desk,
        source: SimSource,
        broker: PaperBroker,
        risk: Risk,
        rng: random.Random,
        duration: float,
    ) -> None:
        self.desk = desk
        self.source = source
        self.broker = broker
        self.risk = risk
        self.rng = rng
        self.duration = duration

        # Hard handoff queues between stages.
        self.scout_q: "asyncio.Queue[Optional[Candidate]]" = asyncio.Queue()
        self.filter_q: "asyncio.Queue[Optional[Candidate]]" = asyncio.Queue()
        self.analyst_q: "asyncio.Queue[Optional[Dict[str, Any]]]" = asyncio.Queue()

        self._stop = asyncio.Event()
        self.equity_samples: List[Dict[str, float]] = []

    # --- Scout: pull synthetic candidates from the source -----------------
    async def scout(self) -> None:
        self.desk.log("scout", "start", reason="scanning synthetic source")
        while not self._stop.is_set():
            cand = self.source.next_candidate()
            self.desk.log(
                "scout",
                "candidate",
                symbol=cand.symbol,
                reason="new synthetic candidate",
                data={
                    "token_id": cand.token_id,
                    "liquidity": cand.liquidity,
                    "age_seconds": cand.age_seconds,
                    "price": cand.price,
                },
            )
            await self.scout_q.put(cand)
            await self.desk.clock.sleep(self.rng.uniform(0.3, 0.9))
        await self.scout_q.put(None)

    # --- Filter: drop candidates failing generic heuristics ---------------
    async def filter(self) -> None:
        while True:
            cand = await self.scout_q.get()
            if cand is None:
                await self.filter_q.put(None)
                return
            if cand.liquidity < 2_000.0:
                self.desk.log(
                    "filter",
                    "reject",
                    symbol=cand.symbol,
                    reason="low_liquidity",
                    data={"liquidity": cand.liquidity},
                )
                continue
            if cand.age_seconds > 540.0:
                self.desk.log(
                    "filter",
                    "reject",
                    symbol=cand.symbol,
                    reason="too_old",
                    data={"age_seconds": cand.age_seconds},
                )
                continue
            self.desk.log(
                "filter",
                "pass",
                symbol=cand.symbol,
                reason="passed_heuristics",
                data={"liquidity": cand.liquidity},
            )
            await self.filter_q.put(cand)

    # --- Analyst: score survivors and decide enter/skip -------------------
    async def analyst(self) -> None:
        while True:
            cand = await self.filter_q.get()
            if cand is None:
                await self.analyst_q.put(None)
                return
            score = round(
                0.5 * cand.momentum
                + 0.3 * min(1.0, cand.liquidity / 50_000.0)
                + 0.2 * (1.0 - min(1.0, cand.age_seconds / 600.0)),
                4,
            )
            if score < 0.25:
                self.desk.log(
                    "analyst",
                    "skip",
                    symbol=cand.symbol,
                    reason="low_score",
                    data={"score": score},
                )
                continue
            self.desk.log(
                "analyst",
                "enter",
                symbol=cand.symbol,
                reason="score_ok",
                data={"score": score, "price": cand.price},
            )
            await self.analyst_q.put({"candidate": cand, "score": score})

    # --- Executor <-> Risk: open/manage synthetic positions ---------------
    async def executor(self) -> None:
        while True:
            item = await self.analyst_q.get()
            if item is None:
                return
            cand: Candidate = item["candidate"]
            score: float = item["score"]
            size = round(self.risk.limits.max_position_size * min(1.0, 0.5 + score), 2)

            decision = self.risk.check_open(size)
            self.desk.log(
                "risk",
                "approve" if decision["allow"] else "block",
                symbol=cand.symbol,
                reason=decision["reason"],
                data={"size": size},
            )
            if not decision["allow"]:
                continue

            pos = self.broker.open(cand, size, self.desk.clock.now())
            self.desk.log(
                "executor",
                "open",
                symbol=cand.symbol,
                reason="position_opened",
                data={
                    "entry_price": pos.entry_price,
                    "size": pos.size,
                    "token_id": pos.token_id,
                },
            )

    # --- Position manager: mark, risk-check, and close positions ----------
    async def manager(self) -> None:
        while not self._stop.is_set():
            await self.desk.clock.sleep(0.5)
            dd = self.risk.check_drawdown()
            if dd["halt"]:
                self.desk.log(
                    "risk",
                    "halt",
                    reason="max_drawdown",
                    data={"drawdown": dd["drawdown"]},
                )
                # Flatten all positions on halt.
                for symbol in list(self.broker.positions.keys()):
                    realized = self.broker.close(symbol)
                    self.desk.log(
                        "executor",
                        "close",
                        symbol=symbol,
                        reason="risk_halt",
                        data={"realized": realized},
                    )
                self._stop.set()
                break

            for symbol in list(self.broker.positions.keys()):
                self.broker.mark(symbol)
                pos = self.broker.positions[symbol]
                age = self.desk.clock.now() - pos.opened_at
                take_profit = pos.pnl >= 0.12 * pos.entry_price * pos.size
                stop_loss = pos.pnl <= -0.08 * pos.entry_price * pos.size
                timed_out = age >= 6.0
                if take_profit or stop_loss or timed_out:
                    realized = self.broker.close(symbol)
                    kind = "close" if realized is not None and realized >= 0 else "loss"
                    reason = (
                        "take_profit"
                        if take_profit
                        else "stop_loss"
                        if stop_loss
                        else "timeout"
                    )
                    self.desk.log(
                        "executor",
                        kind,
                        symbol=symbol,
                        reason=reason,
                        data={"realized": realized},
                    )

            self.equity_samples.append(
                {"t": round(self.desk.clock.now(), 3), "equity": self.broker.equity()}
            )

    async def timer(self) -> None:
        await self.desk.clock.sleep(self.duration)
        self.desk.log(
            "scout",
            "stop",
            reason="duration_reached",
            data={"duration": self.duration},
        )
        self._stop.set()

    async def run(self) -> None:
        tasks = [
            asyncio.create_task(self.scout()),
            asyncio.create_task(self.filter()),
            asyncio.create_task(self.analyst()),
            asyncio.create_task(self.executor()),
            asyncio.create_task(self.manager()),
            asyncio.create_task(self.timer()),
        ]
        await asyncio.gather(*tasks, return_exceptions=True)

        # Flatten any remaining synthetic positions at end of run.
        for symbol in list(self.broker.positions.keys()):
            realized = self.broker.close(symbol)
            self.desk.log(
                "executor",
                "close",
                symbol=symbol,
                reason="end_of_run",
                data={"realized": realized},
            )
        self.equity_samples.append(
            {"t": round(self.desk.clock.now(), 3), "equity": self.broker.equity()}
        )


# ---------------------------------------------------------------------------
# Logger agent: renders, persists, and streams every event
# ---------------------------------------------------------------------------
class Logger:
    """Drains the event bus: renders, writes events.jsonl, forwards to hermes."""

    def __init__(
        self,
        desk: Desk,
        client: Optional[HermesClient],
        events_path: Path,
        use_ui: bool,
    ) -> None:
        self.desk = desk
        self.client = client
        self.events_path = events_path
        self.events: List[Dict[str, Any]] = []
        self.use_ui = use_ui and _RICH_AVAILABLE
        self._console = _RichConsole() if self.use_ui else None
        self._count = 0

    def _render(self, event: Event) -> None:
        d = event.to_dict()
        level = d.get("level") or _infer_level(d)
        line = _format_line(d, level)
        if self._console is not None:  # pragma: no cover - rich not installed
            color = {
                INFO: "green",
                WARN: "yellow",
                ERROR: "red",
            }.get(level, "white")
            self._console.print(f"[{color}]{line}[/{color}]")
        else:
            print(line)

    async def run(self) -> None:
        with self.events_path.open("w", encoding="utf-8") as fh:
            while True:
                event = await self.desk.bus.get()
                if event is None:
                    return
                d = event.to_dict()
                self.events.append(d)
                self._count += 1
                fh.write(json.dumps(d) + "\n")
                fh.flush()
                self._render(event)
                if self.client is not None:
                    # Fail-soft: never let a dashboard outage stop the sim.
                    self.client.emit(d)


def _infer_level(event: Dict[str, Any]) -> str:
    # Mirror hermes_client.level_for_event for rendering without importing it
    # at module scope twice. Kept intentionally simple.
    from hermes_client import level_for_event

    return level_for_event(event)


def _format_line(event: Dict[str, Any], level: str) -> str:
    agent = event.get("agent", "?")
    kind = event.get("kind", "?")
    symbol = event.get("symbol") or "-"
    reason = event.get("reason") or ""
    data = event.get("data") or {}
    data_str = " ".join(f"{k}={v}" for k, v in data.items())
    stamp = time.strftime("%H:%M:%S")
    return f"{stamp} {level.upper():5s} [{agent:>8}] {kind:<10} {symbol:<14} {reason} {data_str}".rstrip()


# ---------------------------------------------------------------------------
# Recap builder
# ---------------------------------------------------------------------------
def build_recap(config: Dict[str, Any], events: List[Dict[str, Any]], equity: List[Dict[str, float]]) -> str:
    opens = sum(1 for e in events if e.get("agent") == "executor" and e.get("kind") == "open")
    closes = sum(
        1
        for e in events
        if e.get("agent") == "executor" and e.get("kind") in ("close", "loss")
    )
    rejects = sum(1 for e in events if e.get("kind") == "reject")
    halts = sum(1 for e in events if e.get("kind") == "halt")
    start_equity = equity[0]["equity"] if equity else 0.0
    end_equity = equity[-1]["equity"] if equity else 0.0
    net = round(end_equity - start_equity, 2)

    lines = [
        "# sim-desk run recap",
        "",
        "> **SIMULATION ONLY** -- synthetic market, paper fills, no real funds.",
        "",
        "## Run",
        "",
        f"- run id: `{config.get('run_id')}`",
        f"- mode: `{config.get('mode')}` (simulation)",
        f"- duration (s): {config.get('duration')}",
        f"- speed: {config.get('speed')}",
        f"- seed: {config.get('seed')}",
        f"- channel: `{config.get('channel')}`",
        f"- hermes url: {config.get('hermes_url')}",
        "",
        "## Results",
        "",
        f"- events logged: {len(events)}",
        f"- positions opened: {opens}",
        f"- positions closed: {closes}",
        f"- filter rejects: {rejects}",
        f"- risk halts: {halts}",
        f"- starting equity: {start_equity}",
        f"- ending equity: {end_equity}",
        f"- net (synthetic): {net}",
        "",
        "_All figures are synthetic and generated by a seeded RNG._",
        "",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Run orchestration
# ---------------------------------------------------------------------------
async def _run_sim(args: argparse.Namespace) -> int:
    run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    seed = args.seed if args.seed is not None else random.randrange(1 << 30)
    rng = random.Random(seed)
    clock = Clock(speed=args.speed)
    desk = Desk(clock)
    source = SimSource(rng)
    broker = PaperBroker(rng)
    risk = Risk(broker, RiskLimits())

    client: Optional[HermesClient] = None
    if not args.no_stream:
        client = HermesClient(base_url=args.hermes_url, channel=args.channel)

    config = {
        "run_id": run_id,
        "mode": "sim",
        "simulation": True,
        "note": "SIMULATION ONLY - no real market, wallet, or funds.",
        "duration": args.duration,
        "speed": args.speed,
        "seed": seed,
        "channel": args.channel,
        "hermes_url": args.hermes_url,
        "stream_enabled": not args.no_stream,
        "ui": (not args.no_ui) and _RICH_AVAILABLE,
    }
    (run_dir / "config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")

    print(BANNER)
    print(f"run id: {run_id}  seed: {seed}  channel: {args.channel}")
    if not _RICH_AVAILABLE and not args.no_ui:
        print("[sim-desk] rich not installed; using plain console output")
    if args.no_stream:
        print("[sim-desk] dashboard streaming disabled (--no-stream)")
    else:
        print(f"[sim-desk] streaming to {args.hermes_url}/ingest -> channel '{args.channel}'")

    logger = Logger(desk, client, run_dir / "events.jsonl", use_ui=not args.no_ui)

    # Initial SIMULATION-labeled event.
    desk.log(
        "desk",
        "start",
        reason="simulation_start",
        message="SIMULATION desk starting -- synthetic market, paper fills, no real funds",
        data={"run_id": run_id, "seed": seed, "simulation": True},
        level=INFO,
    )

    pipeline = Pipeline(desk, source, broker, risk, rng, duration=args.duration)

    logger_task = asyncio.create_task(logger.run())
    await pipeline.run()

    desk.log(
        "desk",
        "stop",
        reason="simulation_complete",
        message="SIMULATION desk complete",
        data={"equity": broker.equity(), "fills": broker.fills},
        level=INFO,
    )
    # Signal the logger to drain and exit.
    desk.bus.put_nowait(None)
    await logger_task

    # Write equity.csv
    with (run_dir / "equity.csv").open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["t", "equity"])
        for sample in pipeline.equity_samples:
            writer.writerow([sample["t"], sample["equity"]])

    recap = build_recap(config, logger.events, pipeline.equity_samples)
    (run_dir / "recap.md").write_text(recap, encoding="utf-8")

    print(f"[sim-desk] run complete: {run_dir}")
    print(f"[sim-desk] events={len(logger.events)} equity={broker.equity()}")
    if client is not None:
        print(f"[sim-desk] streamed={client.sent} soft-failures={client.failures}")
    return 0


def _run_recap(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir)
    if not run_dir.is_absolute():
        run_dir = (RUNS_DIR / args.run_dir) if not run_dir.exists() else run_dir
    config_path = run_dir / "config.json"
    events_path = run_dir / "events.jsonl"
    equity_path = run_dir / "equity.csv"
    if not config_path.exists() or not events_path.exists():
        print(f"[recap] run directory incomplete or missing: {run_dir}")
        return 1

    config = json.loads(config_path.read_text(encoding="utf-8"))
    events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    equity: List[Dict[str, float]] = []
    if equity_path.exists():
        with equity_path.open("r", encoding="utf-8", newline="") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                equity.append({"t": float(row["t"]), "equity": float(row["equity"])})

    recap = build_recap(config, events, equity)
    (run_dir / "recap.md").write_text(recap, encoding="utf-8")
    print(recap)
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    env_url = os.environ.get("HERMES_URL", "http://localhost:4000")
    env_channel = os.environ.get("DESK_CHANNEL", "desk")

    parser = argparse.ArgumentParser(
        prog="sim_desk.py",
        description="SIMULATION-ONLY multi-agent desk that streams to hermes-terminal.",
    )
    sub = parser.add_subparsers(dest="command")

    sim = sub.add_parser("sim", help="run the synthetic simulation (the only run mode)")
    sim.add_argument("--duration", type=float, default=30.0, help="simulation seconds")
    sim.add_argument("--speed", type=float, default=4.0, help="clock speed multiplier")
    sim.add_argument("--seed", type=int, default=None, help="RNG seed (reproducible runs)")
    sim.add_argument("--no-ui", action="store_true", help="force plain console output")
    sim.add_argument("--channel", default=env_channel, help="dashboard channel (default 'desk')")
    sim.add_argument("--hermes-url", default=env_url, help="hermes-terminal base URL")
    sim.add_argument("--no-stream", action="store_true", help="disable dashboard streaming")

    recap = sub.add_parser("recap", help="rebuild recap.md from a local run dir (offline)")
    recap.add_argument("run_dir", help="path to a runs/<id> directory (or just <id>)")

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    # Default-and-only run mode is 'sim' when no subcommand is given.
    if args.command is None:
        args = parser.parse_args(["sim", *(argv or [])])

    if args.command == "recap":
        return _run_recap(args)

    # sim
    loop_result = 0

    def _handle_sigint(*_: Any) -> None:  # pragma: no cover - interactive only
        raise KeyboardInterrupt

    try:
        signal.signal(signal.SIGINT, _handle_sigint)
    except (ValueError, OSError):  # pragma: no cover - non-main thread
        pass

    try:
        loop_result = asyncio.run(_run_sim(args))
    except KeyboardInterrupt:  # pragma: no cover - interactive only
        print("\n[sim-desk] interrupted")
        loop_result = 130
    return loop_result


if __name__ == "__main__":
    raise SystemExit(main())
