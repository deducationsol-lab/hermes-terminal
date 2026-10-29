# sim-desk — simulation-only multi-agent desk

> ## ⚠️ SIMULATION ONLY
>
> This demo is a **SIMULATION**. It uses **no real-market data, no real wallet,
> no real funds, no RPC, no private keys, and no autonomous execution**. Every
> market event, fill, and equity figure is **synthetic**, generated locally
> from a seeded random number generator. There is **no live mode**, no "paper"
> mode against real data, and no trade-authorization path. The only run mode is
> the synthetic `sim` mode (plus an offline `recap` reader). It exists purely
> to demonstrate a multi-agent pipeline streaming structured logs into the
> generic [hermes-terminal](../../README.md) dashboard.

`sim-desk` is a small, self-contained Python producer for hermes-terminal. It
runs six cooperating agents connected by hard queue handoffs and streams every
agent's structured log event into the dashboard over HTTP `/ingest`, so you can
watch the whole pipeline live.

## Architecture

```
SimSource ──▶ Scout ──▶ Filter ──▶ Analyst ──▶ Executor ◀──▶ Risk
                 \         \          \            \         /
                  '────────── Logger hears everyone ────────'
                                      │
                                      ▼
                       hermes-terminal /ingest (channel "desk")
```

- **SimSource** — generates synthetic instrument candidates from a seeded RNG.
  No external data of any kind.
- **Scout** — pulls candidates from `SimSource` and forwards them downstream.
- **Filter** — drops candidates that fail generic liquidity/age heuristics.
- **Analyst** — scores survivors and decides enter/skip.
- **Executor ↔ Risk** — opens and manages synthetic positions through the
  **PaperBroker**, consulting **Risk** before every open and on every tick.
  `Risk` enforces generic exposure, position-count, and drawdown limits and can
  halt the run.
- **Logger** — hears **every** agent via a shared event bus. It renders the
  stream (plain console, or an optional [rich](https://github.com/Textualize/rich)
  UI), appends each event to `runs/<id>/events.jsonl`, and forwards every event
  to hermes-terminal (fail-soft).

The agents hand work off through hard `asyncio.Queue` boundaries
(Scout → Filter → Analyst → Executor), and the Executor consults Risk
synchronously before acting. All synthetic prices drift via a seeded random
walk inside the **PaperBroker**; fills are modeled with a small synthetic
slippage.

### Event shape

Every agent emits a structured event with **generic** fields:

| Field    | Example                        | Meaning                            |
| -------- | ------------------------------ | ---------------------------------- |
| `agent`  | `"analyst"`                    | Which agent emitted the event.     |
| `kind`   | `"enter"`                      | Generic event kind.                |
| `symbol` | `"SIM-ABC001"`                 | Synthetic instrument id (made up). |
| `reason` | `"score_ok"`                   | Short machine-readable reason.     |
| `data`   | `{ "score": 0.42 }`            | Arbitrary per-event detail dict.   |

These map to the hermes-terminal ingest payload `{channel, level, message,
meta}`: `message` is a human-readable line, `level` is `info` for normal
activity, `warn` for losing/halt/reject-type events, and `error` for hard
failures, and `meta` packs `agent`, `kind`, `symbol`, `reason`, and `data`.

## Requirements

- **Python 3.11** (standard library only for the core).
- **rich** is the single **optional** dependency (colorized UI). The import is
  guarded, so everything runs with rich absent; `--no-ui` forces plain output.

```bash
# nothing is required; optionally install the rich UI:
pip install -r requirements.txt   # installs nothing by default
pip install rich                  # if you want the colorized UI
```

## Run

From this directory:

```bash
# shortest run, no dashboard, no UI:
python3 sim_desk.py sim --no-ui --duration 10 --no-stream
```

The simulation writes artifacts under `runs/<run-id>/`:

- `events.jsonl` — one JSON event per line (everything the Logger heard),
- `equity.csv` — the synthetic equity curve over time,
- `config.json` — the resolved run config (includes the `SIMULATION` marker and
  the chosen channel/url),
- `recap.md` — a summary produced by the recap builder.

### Stream into the dashboard

1. Start hermes-terminal from the repo root:

   ```bash
   npm start
   ```

2. Run the sim pointed at it (this is the default URL and channel):

   ```bash
   python3 sim_desk.py sim --no-ui --duration 30 --channel desk \
     --hermes-url http://localhost:4000
   ```

3. Open the dashboard on the `desk` channel and watch the agents stream:

   [http://localhost:4000/?channel=desk](http://localhost:4000/?channel=desk)

If the server is down the sim keeps running regardless — the client is
**fail-soft** and just logs a local warning.

### Flags

| Flag           | Default                  | Meaning                                   |
| -------------- | ------------------------ | ----------------------------------------- |
| `--duration`   | `30`                     | Simulation seconds.                       |
| `--speed`      | `4.0`                    | Clock speed multiplier.                   |
| `--seed`       | random                   | RNG seed for reproducible runs.           |
| `--no-ui`      | off                      | Force plain console output.               |
| `--channel`    | `desk` (`DESK_CHANNEL`)  | Dashboard channel.                        |
| `--hermes-url` | `http://localhost:4000` (`HERMES_URL`) | hermes-terminal base URL.   |
| `--no-stream`  | off                      | Disable dashboard streaming entirely.     |

Environment fallbacks: `HERMES_URL` and `DESK_CHANNEL`.

## Recap (offline)

The `recap` command reads a local run directory only (no network, no market)
and re-emits `recap.md`:

```bash
python3 sim_desk.py recap runs/<run-id>
# or just the id:
python3 sim_desk.py recap <run-id>
```

## Tests

```bash
python3 -m unittest discover -s . -p 'test_*.py'
```

The test asserts the `/ingest` payload shape (channel/level/message/meta) and
that the client fails soft when no server is running.
