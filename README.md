# hermes-terminal

## GMGN Solana showcase — simulated execution

The default dashboard polls a same-origin `/api/market` endpoint every 25s.
The server uses `GMGN_API_KEY` (Preview and Production) to call only GMGN's
read-only `/v1/market/rank` route. No signing keys, wallets, swaps or order
submission. Authentication/query format follows the official gmgn-cli client.
Never expose this key through browser globals or public-prefixed variables.

Tokens must appear in either GMGN's 5-minute or 1-hour trending ranking, with
≥$5,000 market cap (no upper cap), ≥$1,000 USD volume in that matching window,
≥$1,500 current liquidity, top 10 wallets holding 12–28% combined (inclusive),
creation age 0–500 minutes, and at least one Twitter/X handle, Telegram link or
project website. Age uses token creation, not pool opening. Mint and freeze
authorities must be reported revoked and LP status explicitly `burn`. Missing,
invalid or unknown required fields fail closed; no safety inference from absence.
These are provider-reported checks, **not independent on-chain verification or
safety guarantees**. Two paced ranking reads are unioned/deduplicated by mint;
volume qualifies independently per window, never by adding windows. A failure
in either read pauses the market snapshot rather than serving a partial union.
At most 12 eligible results reach the browser, which watches four at a time.
Held tokens remain quote-managed even if they cease to meet entry filters.

The scanner checks the candidate's main pool via read-only token-info and
highlights reported WSOL, USDC, USD1 and SOL quote symbols with a PAIR badge.
Unknown pairs remain unknown, not inferred from the token name. These highlights
are informational, not extra allowlist filters or mint-identity guarantees.
The added ranking and pair reads share existing pacing; scans may take longer
and do not guarantee catching every signal. No buys are forced if the list is empty.
Each session tracks at most four tokens, keyed by mint, with $10,000 virtual
USD cash. Risk management caps each buy at **5% of initial session capital
($500 total including entry fees)**, not 5% of current equity. At 0.10% fees,
this buys approximately $499.50 of tokens plus $0.50 fee; adverse slippage is
already included in the simulated fill price. Profits do not increase the cap.
Insufficient available cash skips entry (no borrowing); no top-ups to existing
positions. This is an allocation cap, not a guarantee that losses stay below 5%.
Existing stop-loss and moonbag exits are unchanged; sell orders are not capped,
so risk-reducing exits can liquidate the required amount. No SMC entry filters
are added. No leverage. Entries require a **closed M1 hammer or inverted hammer**, or the existing
**bullish body-engulfing pattern on the last two closed M1/M5 candles**. Either
pattern is sufficient on its own; no three-declining-candle or volume gate. For hammers, the lower wick must be at least 2× the
nonzero body and the upper wick at most half the body; inverted hammers mirror
those wick requirements. Either body color qualifies; dojis do not. Hammer
patterns qualify only on M1, never M5. Enter during the immediately next candle,
using a fresh observed quote, not a fabricated candle-open or candle-close fill.
Reversals need only the last closed candle; engulfing needs the last two consecutive
closed candles (bearish then bullish, with a strictly engulfing body). Older history
and volume do not gate entries. Unfinished, expired, reused, stale, invalid or missing
pattern candles never enter. Polling may delay or miss entries; exact candle-open
execution is not guaranteed.
One candidate is checked each polling cycle (25s plus request pacing), rotating across at most four
watched tokens; this is not exhaustive detection of every market signal.

Before profit taking, a quote at or below 65% of entry triggers full simulated
exit; that token is blacklisted until reset and replaced by an eligible candidate.
At 1.5× entry, sell 90% of original tokens and retain 10% as a moonbag. Moonbags
have **no stop-loss**. If a holding leaves the cap/liquidity entry universe, a
read-only token-info lookup keeps it tracked at any cap; missing holding prices
are refreshed one per cycle in rotation, prioritizing exits over new entries. At 5× entry sell 90% of the remaining bag; at 10× sell
90% of the remainder again. Each milestone fires only once. Both multiples use
the original simulated fill entry, not the previous milestone. The final bag
is 0.1% of original quantity. Gaps through multiple profit levels process them
in order at the currently observed price, not fabricated threshold prices.
No time-based or momentum exits remain in the default strategy. Estimated fees 0.10%
and adverse slippage 0.05% per side are not realistic guarantees for low-cap
execution: actual spreads, liquidity, MEV, taxes and failed swaps can be far worse.
This is a deterministic demo heuristic, not an AI investment adviser or validated
strategy. Prices are retrieved snapshots, not executable quotes or a guaranteed
exchange event timestamp. Fills and all P/L remain simulated and session-only.

Missing/invalid quotes pause exits only for affected holdings, retaining their last-known marks. Candle outages block new entries but do not disable valid quote-driven exits for existing holdings.
Polling cannot guarantee a −35% fill: gaps, outages and low-cap slippage can cause much larger losses. Moonbags can lose their entire value. No synthetic fallback or invented sale. Reset starts a new universe/account.
Pause/Resume, filters, and exports remain available. `?mode=live&channel=desk`
opens producer logs; `?mode=synthetic` explicitly selects the offline demo.

Upstream requests are coalesced and cached per warm instance for 20s, successful
responses use a 20s CDN cache, and failures have a 20s cooldown (not a global
quota guarantee). A Redis-backed shared gate also spaces read requests ≥10s apart; 429 responses pause all new GMGN requests for at least five minutes, and 403 responses for an hour. GMGN quota/authorization or regional/network restrictions can
pause the showcase. Configure rate limiting before exposing this to large public
traffic. Provider error bodies and keys are never returned to the browser.

A standalone, generic real-time **live-log streaming infrastructure**.

`hermes-terminal` ingests structured log events from producers over a simple
HTTP endpoint and fans them out over WebSocket to connected browser clients. A
self-contained terminal dashboard renders the live stream with color-coded log
levels, auto-scroll, and automatic reconnect.

## Overview

The system is **completely domain-agnostic**. It streams whatever structured
log events it is given and has no knowledge of any particular application
domain. An event is just:

- a **channel** (a named room events are grouped under),
- a **level** (`debug`, `info`, `warn`, `error`, or any custom string),
- a human-readable **message**,
- optional structured **meta** data,
- plus a server-assigned timestamp (`ts`) and sequence number (`seq`).

Producers emit events to a named channel; browser clients subscribe to a single
channel and receive recent history followed by live events. There is no
persistence beyond an in-memory ring buffer and no authentication, so it is
intended for local and demo use.

## Architecture

```
producers ──HTTP POST /ingest──▶  ┌─────────────────────────────┐
                                   │          server             │
                                   │  LogHub                     │
                                   │   └─ per-channel ring buffer │
                                   │      (last N events each)    │
                                   └──────────────┬──────────────┘
                                                  │ WebSocket fan-out
browser dashboards ◀──────────────────────────────┘
        (subscribe ?channel=NAME, static files served from public/)
```

- **HTTP ingest**: producers `POST /ingest` with a JSON event.
- **In-memory per-channel ring buffer**: each channel keeps its last **N**
  events (default 500, configurable). No database, no disk.
- **WebSocket fan-out**: each event published to a channel is broadcast to every
  client currently subscribed to that channel.
- **Static dashboard**: a plain HTML/CSS/JS terminal view is served directly
  from the server out of `public/`.

## Requirements

- **Node.js 18+** (the global `fetch` used by the client helper requires 18 or
  newer). This project is developed and tested on **Node 22**.
- npm.

## Install

```bash
npm install
```

## Build

Compiles the TypeScript sources to `dist/` with `tsc`:

```bash
npm run build
```

## Run the server

```bash
npm start
```

This runs the compiled server (`dist/src/server.js`) and listens on
`http://localhost:4000` by default.

Environment variables:

| Variable           | Default | Description                                  |
| ------------------ | ------- | -------------------------------------------- |
| `PORT`             | `4000`  | TCP port the server listens on.              |
| `RING_BUFFER_SIZE` | `500`   | Number of events retained per channel.       |

Example:

```bash
PORT=8080 RING_BUFFER_SIZE=1000 npm start
```

> During development you can run the server with live reload instead:
> `npm run dev` (runs `src/server.ts` directly via `tsx`).

## Open the dashboard

Open [http://localhost:4000](http://localhost:4000) in a browser. The dashboard
**auto-connects on load**: it immediately opens a panel for the active channel
and starts streaming, with no manual Connect click. When `?channel=` is absent
the auto-opened panel uses the channel `demo`. The dashboard shows a connection
status indicator, color-codes levels (`debug` gray, `info` green, `warn`
yellow, `error` red), auto-scrolls, and automatically reconnects with
exponential backoff if the connection drops.

You can preselect a channel via the `?channel=` query parameter, e.g.
[http://localhost:4000/?channel=demo](http://localhost:4000/?channel=demo), and
use the **Add panel** form to open additional channels side by side.

## Dashboard features

The dashboard is plain HTML/CSS/JS with no framework and no build step. Like
the rest of the system it is **strictly domain-agnostic**: every widget is
computed purely from whatever generic log events and `meta` a producer sends,
and it makes no assumptions about what those events represent. It ships eight
upgrades:

1. **Theming.** A light/dark set of four palettes (Midnight, Light, Ocean,
   Amber) selectable from the top bar. The choice is applied before first paint
   and persisted to `localStorage` so it is restored on reload.
2. **Multi-panel layout.** Watch several channels side by side in split panes
   instead of one at a time. Each panel owns its own WebSocket connection, its
   own in-memory buffer, and its own view state. The open set of channels is
   persisted to `localStorage`.
3. **Filtering and search.** Each panel has a level toggle bar (toggle
   `debug`/`info`/`warn`/`error` plus an `other` bucket for custom levels) and a
   free-text search box that matches over messages and highlights the hits.
4. **Metrics and throughput strip.** A compact per-panel stats strip showing
   events per second, total event count, per-level counts (including any custom
   levels discovered in the stream), and the connection status. Every figure is
   computed from that panel's in-memory buffer and refreshed on a timer.
5. **Generic ticker strip.** A configurable top strip that surfaces key/value
   pairs from event `meta`. It is **fully generic**: it auto-discovers whatever
   keys the incoming `meta` objects provide, tracks the most recent value seen
   for each key, and renders `label=value` chips. There are no hardcoded labels
   of any kind. You can toggle the ticker on or off and choose which discovered
   keys to display; this configuration persists to `localStorage`. Object
   values are serialized with `JSON.stringify`, and every key and value is
   written with `textContent` because producer-supplied data is untrusted. The
   discovered keys and values are scoped to the panels that are currently open:
   closing or clearing a panel drops the keys it contributed, so the ticker
   always reflects the channels you are actually watching rather than stale
   values from a channel that is no longer present.
6. **Pause/resume and buffering.** Freeze a panel's view to inspect it without
   losing incoming events. Events keep accumulating in the buffer while paused
   (with a live "buffered" count), then render on resume so you catch up. The
   pause buffer is capped at the same limit as the main buffer, so a long pause
   under heavy load cannot grow memory without bound; if the cap is reached the
   oldest buffered events are dropped and the indicator reports the overflow.
7. **Export.** Download the current buffer as either JSON or NDJSON. The export
   always reflects the full buffer, not just the filtered view.
8. **Per-event detail.** Click (or press Enter/Space on) a line to expand its
   full event payload, including the complete `meta` object, pretty-printed.

The metrics computation is a small pure function in `src/metrics.ts`
(`computeMetrics`) with unit tests in `test/metrics.test.ts`; the browser
mirrors the same logic inline so the authoritative behavior stays tested.

## Producer HTTP API

Producers send events with an HTTP `POST` to `/ingest`:

- **Method**: `POST`
- **Path**: `/ingest`
- **Content-Type**: `application/json`
- **Body**:

  ```json
  {
    "channel": "demo",
    "level": "info",
    "message": "handling request",
    "meta": { "method": "GET", "path": "/", "status": 200 }
  }
  ```

  `channel` and `message` are required (a missing or empty value returns
  `400`). `level` defaults to `"info"` if omitted. `meta` is an optional object.
  An optional `ts` (ms since epoch) may be supplied; otherwise the server
  assigns one.

On success the server responds `200` with the **stored event**, including the
server-assigned `seq` and `ts`:

```json
{
  "channel": "demo",
  "level": "info",
  "message": "handling request",
  "meta": { "method": "GET", "path": "/", "status": 200 },
  "ts": 1716153600000,
  "seq": 1
}
```

curl example:

```bash
curl -X POST http://localhost:4000/ingest \
  -H 'content-type: application/json' \
  -d '{"channel":"demo","level":"info","message":"hello world","meta":{"example":true}}'
```

The server also exposes `GET /healthz`, which returns `200 ok` as a liveness
probe.

## LogClient helper

`src/client.ts` provides a tiny, dependency-free `LogClient` that wraps the
`/ingest` endpoint using the global `fetch`. Construct it with a base URL and a
channel, then emit events:

```ts
import { LogClient } from './src/client';

const client = new LogClient({
  baseUrl: 'http://localhost:4000',
  channel: 'demo',
});

await client.info('service started', { pid: process.pid });
await client.debug('cache miss, loading from store', { key: 'item:42' });
await client.warn('slow response detected', { durationMs: 1200 });
await client.error('request failed', { status: 500 });

// Or the generic form with any custom level:
await client.log('info', 'handling request', { method: 'GET', path: '/' });
```

## Channels, rooms, and the ring buffer

- Producers write to a **named channel**. Any string is a valid channel name;
  channels are created on first use.
- A browser client **subscribes to a single channel** (via `?channel=NAME` on
  the WebSocket connection, defaulting to `default`).
- Each channel has its own **in-memory ring buffer** holding the last **N**
  events (default 500, set with `RING_BUFFER_SIZE`). When the buffer is full the
  oldest event is dropped.
- On connect, a client immediately receives the current **history** (the events
  still in that channel's ring buffer), then every subsequent live event.

## WebSocket message protocol

Clients connect to the server's WebSocket endpoint with a channel query
parameter, e.g. `ws://localhost:4000/?channel=demo`. All server-to-client
messages are JSON objects tagged with a `type` field:

- **`history`**: sent once, immediately on connect:

  ```json
  { "type": "history", "events": [ /* LogEvent, ... */ ] }
  ```

- **`event`**: sent for every new live event on the subscribed channel:

  ```json
  { "type": "event", "event": { /* LogEvent */ } }
  ```

Each `LogEvent` has the shape `{ channel, level, message, meta?, ts, seq }`.

## Demo

A runnable demo producer emits a continuous stream of generic application log
lines so you can see the system working end to end.

1. Start the server:

   ```bash
   npm start
   ```

2. In another terminal, run the demo producer. It writes to the `demo` channel
   by default; pass a channel name as an argument to override it:

   ```bash
   npm run demo
   # or target a specific channel:
   npm run demo -- my-channel
   ```

3. Open the dashboard on that channel and watch the lines stream in, e.g.
   [http://localhost:4000/?channel=demo](http://localhost:4000/?channel=demo)
   (enter `demo` and click **Add panel**).

The demo producer also honors `DEMO_URL`, `DEMO_CHANNEL`, and
`DEMO_INTERVAL_MS` environment variables.

Each demo line carries generic infrastructure/application telemetry in its
`meta` so the metrics strip and ticker have varied data to surface. All fields
are ordinary, domain-agnostic server telemetry:

| Field               | Example         | Meaning                                  |
| ------------------- | --------------- | ---------------------------------------- |
| `worker`            | `"w-3"`         | Worker or instance identifier.           |
| `region`            | `"eu-2"`        | Deployment region label.                 |
| `queueDepth`        | `17`            | Pending items in a work queue.           |
| `activeConnections` | `128`           | Currently open connections.              |
| `cacheHitRatio`     | `0.84`          | Cache hit ratio as a plain number (0-1). |
| `bytesOut`          | `524288`        | Bytes written for the operation.         |
| `method`            | `"GET"`         | Request method (request lines).          |
| `path`              | `"/api/items"`  | Request path (request lines).            |
| `status`            | `200`           | Response status code (request lines).    |
| `durationMs`        | `42`            | Handling duration in milliseconds.       |

Because the ticker and metrics are derived purely from these generic keys, you
can point any producer at the system with its own `meta` shape and the
dashboard will adapt automatically, with no changes to the UI.

## Deploy to Vercel

The project also ships a Vercel-native deployment (Option A) so the dashboard
can run on Vercel's serverless platform. The local `npm start` server is
unchanged; the Vercel path is additive.

> For a concise, actionable pre-deploy checklist (Upstash env vars, project
> settings, health verification, and pointing the sim-desk demo at the deployed
> URL), see [`vercel-deploy.md`](vercel-deploy.md).

### Why the transport differs on Vercel

Locally (and on any long-process host) the dashboard streams over **WebSocket**,
fanning out live events from the in-process `LogHub` ring buffer. Vercel does
**not** run long-lived WebSocket servers, so on Vercel the dashboard streams
over **Server-Sent Events (SSE)** instead. The dashboard picks the transport at
runtime (see "Transport auto-detection" below), so the same static files work
both ways with no build step.

### Why serverless needs an external store

Serverless functions are **stateless** and each request may run in a fresh
invocation, so the in-memory ring buffer cannot be shared across requests. The
Vercel functions therefore back their state with an external **Upstash Redis**
store:

- a per-channel **trimmed Redis list** holds the most recent events (the
  serverless analog of the in-memory ring buffer) and provides the
  recent-history replay a client receives on connect;
- a per-channel monotonic **sequence** lets the SSE stream do **seq-based list
  tailing** for live fan-out: the stream function re-reads the list and forwards
  only events newer than the last one the client has seen. (A connectionless
  REST Redis client cannot hold a blocking subscribe, so tailing is used instead
  of pub/sub.) The list is read back **ordered by seq**, so an event appended to
  the list out of order (seq assignment and the list append are two separate
  REST calls) is still replayed and tailed in the correct sequence.

### Known limitations of the SSE path

The SSE transport is a REST-and-polling approximation of the push-based
in-memory ring buffer, with a few divergences to be aware of:

- **Burst-loss bound.** The per-channel list is capped (`LIST_CAP`, 500). The
  stream polls roughly once per second, so if **more than `LIST_CAP` events are
  appended to one channel between two polls**, the oldest unseen events are
  trimmed out of the list before the client reads them and the client observes
  a seq gap. The push-based WebSocket path never drops events this way. Channels
  whose expected peak exceeds ~500 events/second should raise `LIST_CAP` or
  shorten the poll interval in `api/stream.ts`.
- **Full-list re-read cost.** Each SSE connection re-reads up to `LIST_CAP`
  entries per poll, so REST call volume and egress scale with
  viewers × cap × poll rate. This is fine for the modest cap/interval here but
  is the main scaling cost of the SSE path.
- **Reconnects are routine, and de-duplicated.** A serverless function has a
  bounded lifetime (`maxDuration` in `vercel.json`), so the SSE function is
  recycled periodically and `EventSource` auto-reconnects, replaying the full
  history envelope. The dashboard **de-duplicates by `seq` per channel**, so a
  reconnect does not re-render lines it already showed. (Clearing a panel resets
  this dedup state, so a Clear followed by a reconnect replays the recent
  history into the now-empty view as expected.)

### Steps

1. Create an **Upstash Redis** store and copy its REST URL and REST token.
2. In your Vercel project settings, set the two environment variables (see
   `.env.example`):

   | Variable                   | Description                               |
   | -------------------------- | ----------------------------------------- |
   | `UPSTASH_REDIS_REST_URL`   | REST endpoint URL of the Upstash store.   |
   | `UPSTASH_REDIS_REST_TOKEN` | REST access token for the Upstash store.  |

3. Deploy the repository to Vercel. `vercel.json` serves the static dashboard
   from `public/` as the site root and routes `/api/*` to the serverless
   functions in `api/` (`api/ingest.ts`, `api/stream.ts`, and a dependency-free
   liveness probe `api/healthz.ts` that returns `{"status":"ok"}` without
   needing the Upstash env vars).

After deploying, verify with the checklist in
[`vercel-deploy.md`](vercel-deploy.md): `curl` the health probe, POST a test
event, and open the dashboard on `?channel=desk`.

### Transport auto-detection

The dashboard chooses its transport at runtime with no bundler or build step:

- an explicit `window.HERMES_TRANSPORT` global (`'sse'` or `'ws'`) wins if set;
- otherwise, if the page is served from a Vercel host (`*.vercel.app`), it uses
  SSE;
- otherwise it defaults to WebSocket, so local `npm start` behaves exactly as
  before.

### Auto-connect and the default channel

The dashboard now **auto-connects on page load** with no manual Connect or Add
panel click: it immediately opens a panel for the active channel and starts
streaming. When `?channel=` is absent the auto-opened panel uses the channel
**`demo`**; a `?channel=` value still wins, previously persisted channels still
restore, and the Add panel form still opens additional panels.

## More examples

An optional, self-contained **simulation-only** multi-agent producer lives in
[`examples/sim-desk/`](examples/sim-desk/README.md): it runs a small pipeline of
agents and streams their structured log events into the dashboard on the `desk`
channel. See its README to run it.

## Security

There is **no authentication**. Anyone who can reach the server can ingest
events and subscribe to channels. Run it only for **local or demo use**, or put
your own access control in front of it before exposing it.

## License

MIT

## Automatic GMGN paper trading

The default GMGN terminal is now a **read-only viewer of one shared persistent
virtual account**, not a browser-owned trading loop. Production invokes
`/api/background-run` every minute using Vercel Cron. Closing all tabs, panel
Pause/Clear, or reconnecting never stops or resets that account. The synthetic
`?mode=synthetic` demo remains browser-only. Old tab-local accounts cannot be
migrated: the first server cycle starts a new $10,000 virtual account.

Configure a secret `CRON_SECRET` in Production in addition to the existing
GMGN and Redis variables. The runner fails closed without it, rejects preview
execution and unauthorized calls, and never submits real orders. Preview
viewers can read the existing shared account if they use the same Redis store;
preview deployments cannot execute the cron runner. There is deliberately no
unauthenticated reset/trading-control endpoint.

Account positions, cash, last-known quotes, stop blacklist, used signals,
watch cursors and the latest 500 events are saved in one versioned Redis value.
A five-minute Redis lease prevents overlapping workers; an owner-checked atomic
commit saves account and logs together and rejects an expired worker. Duplicate
cron deliveries in the same minute are skipped. A crash before commit leaves
the previous account intact. The endpoint reports last attempt and last fresh
market success separately; missing data never causes invented fills.

This is periodic snapshot paper trading, **not continuous execution**. Schedules
can be late or missed, cycles may overlap and be skipped, M1 windows can be
missed, and stops can gap. Existing GMGN pacing/cooldowns and all entry/risk
rules remain. Off-universe holdings are quoted one per cycle, round-robin, ahead
of new entries, as before. Server/Redis/GMGN usage continues with no viewers.
There is no catch-up with fabricated historical fills. Redis persistence and
availability are required. Use the production cron logs and `/api/background`
to verify scheduled progress without a browser.

### One buy per token mint

Each token mint can be bought only once for the lifetime of the persistent
virtual account. The durable traded registry is written with the buy and
restored across restarts/deployments. Existing accounts migrate prior entries
from positions, used-signal history and the stop blacklist without resetting
cash or holdings. A new signal, timeframe, price recovery or repeated ranking
cannot re-enter a previously bought mint. Stop-loss exits free the watch slot
for another eligible, never-bought token; no filter bypass or fallback buy.
Normal take-profit/moonbag sells of existing positions remain allowed.
The rule does not label or detect rugs: a valid fresh quote hitting the
existing stop triggers the exit; missing prices never fabricate one.

### Daily loss guard and retained history

The daily entry-loss budget is fixed at **$5,000 (50% of original $10,000)**,
not 50% of the remaining balance. Daily P/L is equity minus opening equity,
including fees, realized results and unrealized last-known marks. Days use
**fixed UTC−04:00** (no daylight-saving changes); midnight is 04:00 UTC.
The first cycle on a new day uses the previous saved marks as opening equity,
then applies new quotes. On first installation into a legacy account, opening
equity is the existing account equity at activation; earlier intraday P/L
cannot be reconstructed as an exact daily baseline.

At daily P/L ≤−$5,000, new buys latch off until the next day even if equity
recovers. Existing position exits, stops and moonbag sells continue. The first
cycle at/after midnight resets only the daily guard: cash, positions, marks,
fees/results, stop blacklist and one-buy-per-mint registry are retained. No
top-up, forced liquidation or account reset. Insufficient cash still skips buys.
This is a snapshot-based entry circuit breaker, **not a guaranteed loss cap**:
gaps, delayed runs and unavailable/stale quotes can exceed the budget.

New logs are archived atomically with account state in dated Redis sorted sets,
without TTL or trimming. The recent terminal view remains capped at 500 events.
On activation the remaining recent logs are backfilled once; older logs already
trimmed cannot be recovered. Archive availability depends on Redis; retained
storage grows with use. There is no automatic archive deletion. Existing public
read access applies to history too: do not ingest secrets or private data.

Open `/history.html` from the terminal to choose a UTC−4 date, page through
100 records at a time and export loaded records as JSON. `/api/history?day=YYYY-MM-DD&offset=0`
returns `nextOffset` for pagination. Export includes only loaded pages; load
more until the end to export a whole day. Archived dates remain accessible
after daily rollover, viewer Clear and redeployments.

### Market-cap exit and moonbag floor (supersedes earlier no-stop moonbag rule)

All holdings, including moonbags, sell their entire remaining quantity on a
fresh valid quote reporting market cap **strictly below $5,000**. Exactly $5,000
remains allowed. Independent holding lookups now carry market cap, since tokens
falling below entry filters disappear from rankings. Missing/invalid cap is not
zero and never fabricates an exit; new background entries require a known
independent quote cap ≥$5,000 as well as the existing ranking filters.

When the +50% profit sell first creates a moonbag, persist that observed quote
price as its fixed anchor. Sell the entire remaining moonbag at **≤50% of that
anchor**, not 50% of a later high or original entry. This supersedes the previous
no-stop moonbag policy. Staged 5×/10× profit sells remain unchanged. Cap exits take
precedence; no duplicate sells. All exited mints remain blocked from re-entry.

For existing moonbags, recover the creation quote from a retained take-profit
fill where available (undoing estimated sell slippage). If it is no longer in
the recent account history, the first fresh quote becomes an explicitly logged
migration baseline instead; no historical creation price is invented. Existing
balances and logs are preserved. Minute polling, round-robin off-universe
holding quotes, upstream outages and gaps can delay exits; simulated fills are
not guarantees of real execution or a loss cap.

### Top-20 five-minute pool (replaces 5m/1h union)

New entries now use only the **first 20 rows returned by GMGN's Solana
five-minute volume-descending ranking**, before local eligibility filtering.
Request `interval=5m`, `limit=20`, `order_by=volume`, `direction=desc` without
upstream eligibility filters so rejected rows cannot be replaced by lower-ranked
ones. Even if the provider returns more rows, positions 21+ are discarded first.
There is no one-hour ranking, fallback universe or replacement from lower ranks.
This is the API volume ranking, not a claim of parity with a separate GMGN UI
trending score. Fewer than 20 (including zero) may pass filters.

Keep five-minute volume ≥$1,000, liquidity ≥$1,500, market cap ≥$5,000, holder,
age, social and safety checks unchanged. Watch at most four eligible tokens as
before, using the same candle entries, sizing, daily guard and exits. Held tokens
outside the new pool still get independent quotes and exit management. Existing
account and archive state is preserved. Activity does not guarantee liquidity
at a fill or profitable execution.

### 30-second target checks (supersedes minute-only checks)

Vercel Cron still invokes once per minute. Each authenticated invocation awaits
two serial background checks: first immediately, second at least 30 seconds
after that invocation started. If the first takes longer, second runs after it
finishes. No detached timers, self-HTTP calls or unbounded daemon. Existing Redis
lease protects every check and a persisted 30-second minimum start-spacing guard
suppresses competing workers/duplicate deliveries. Slow checks, scheduler jitter,
feed pacing/cooldowns and overlap suppression can delay or skip checks; this is
not exact 30-second execution. A crash can lose the second check; next cron
invocation resumes. Existing 240-second invocation limit remains.

Account, daily loss limits, exits and dated logs are unchanged. The browser
already reads saved status every 15 seconds and never drives trading. More
server checks can increase function/Redis/GMGN usage. Wallet-following remains
unconfigured until a transaction-feed integration is set up.

### Helius wallet-following mode (replaces candle entry selection)

Production reads `HELIUS_API_KEY` server-side to poll **only**
`omegoMAe1AMY5MFKQQr3JwXVy8F4eCvmBAfcpo8XAfq` using confirmed
`getTransactionsForAddress` full jsonParsed history (legacy/v0/v1), successful
transactions including associated token accounts. No signing or real swaps,
no webhook required. Existing 30-second target workers remain.

Activation starts now, not at the beginning of historical wallet trading. Cursor,
observed signatures and pending actions commit atomically with account/logs.
Queries reconcile a ten-second overlap, up to three pages of 100 rows. Full page
budget exhaustion fails closed without advancing cursor. Delays over 120 seconds
expire signals; unsupported, failed, unsigned-by-wallet, ambiguous multi-token,
fee-only and ordinary transfer transactions skip. Initial supported program calls:
Pump.fun, Pump AMM and Jupiter V6, with one non-WSOL token balance change and
opposite meaningful SOL/WSOL flow. This is conservative transaction observation,
not a reconstruction of every protocol or the wallet's private algorithm; SOL
balance changes can include rent and fees. Missing/invalid metadata never becomes
an invented trade. Seen history capped at 2,000 signatures with bounded time
reconciliation; pending queue capped at 200. Historical missed buys are not replayed.

New wallet buys must also be in current filtered top-20 5m pool/four-token watch
set with known fresh cap ≥$5,000 and pass existing account/daily/risk checks. No
candle pattern confirmation in wallet mode. At most one wallet action per cycle,
held-token sells prioritized, and a later observed sell cancels an unprocessed
buy for that mint. Use fresh current GMGN quotes, not source-wallet execution
prices or amounts. $500 all-in allocation unchanged; no repeated buys per mint.

Observed wallet sells of our holdings sell 90% of **remaining** quantity when
profitable against allocated cost after estimated fees/slippage, leaving 10%.
Otherwise they close the entire remainder. Moonbag creation anchor is retained;
all existing cap/stop/moonbag/daily protections remain, including legacy staged
profit exits. Existing positions are still managed. No available quote means no
fabricated fill. Helius outage pauses wallet entries, not protective management
when GMGN is available. GMGN failure still prevents quote-based fills. The
initial read-only feed has no guaranteed latency or matching P/L and consumes
Helius credits even when all wallet trades are filtered out.

### Fresh unrestricted-entry Omniverse account (supersedes entry/risk restrictions above)

The user explicitly authorized one fresh $10,000 virtual account, clearing old
positions without pretending they were liquidated. The persisted policy epoch
`omniverse-fresh-2026-10-30-v1` makes this reset **one-time**, committed under the
same Redis lease/fence with an archived prior closing snapshot and reset event.
Event sequence and dated archives continue; nothing wipes history or resets at
midnight. The source-wallet cursor restarts at reset activation so earlier buys
are not replayed. Redeployment/retry does not top up the balance again.

Wallet-mode new buys no longer require top-20 ranking, four-token watch list,
liquidity/volume, holder, age, socials, revocation or LP checks; no candle filter.
The $5,000 daily loss pause is OFF. Daily P/L remains informational in UTC−4.
Each fresh supported wallet buy can spend $500 including estimated entry fees,
only when cash is sufficient; no leverage/borrowing. Duplicate source signatures
are still ignored, and signal freshness, successful supported swap classification,
valid quote data and finite balances are still required. Polling processes one
action per cycle and cannot guarantee every source entry will be simulated.

Repeat buys after full exits are allowed, including after stops. Buys while a
mint is already held **add** quantity and cost with quantity-weighted entry,
not overwrite the holding. A moonbag's existing anchor and one-shot milestones
remain unchanged when adding exposure, so protective exits also apply to the
added amount. Existing full cap exit below $5,000, pre-moonbag −35% stop,
moonbag −50% anchor floor, staged profit exits and followed sells remain.
Consequently, a followed buy below $5,000 cap can enter but will exit on the
next fresh protective check. Profit sells keep 10% of remaining quantity;
nonprofitable followed sells/protective exits close all.

Source swap observations now retain gross SOL counterflow and raw token delta,
with descriptive counts, average buy/sell SOL amounts derivable from totals,
and time from last observed buy to next sell (not FIFO holding duration or net
profit). Observed open times are capped at 500 mints. Logs preserve signals for
future analysis; the system does **not** autonomously learn or change rules.
These statistics only describe supported observed swaps, not the wallet's entire
activity; SOL amounts can include rent/fees. Public wallet masking is unchanged.
No real funds/orders are involved, and this unrestricted mode increases risk of
virtual losses and buying unsafe tokens.
