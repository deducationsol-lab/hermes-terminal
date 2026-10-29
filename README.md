# hermes-terminal

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
