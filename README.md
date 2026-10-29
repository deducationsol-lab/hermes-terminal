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

Open [http://localhost:4000](http://localhost:4000) in a browser. Enter a
channel name and click **Connect** to subscribe to it. The dashboard shows a
connection status indicator, color-codes levels (`debug` gray, `info` green,
`warn` yellow, `error` red), auto-scrolls, and automatically reconnects with
exponential backoff if the connection drops.

You can also preselect a channel via the `?channel=` query parameter, e.g.
[http://localhost:4000/?channel=demo](http://localhost:4000/?channel=demo).

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

- **`history`** — sent once, immediately on connect:

  ```json
  { "type": "history", "events": [ /* LogEvent, ... */ ] }
  ```

- **`event`** — sent for every new live event on the subscribed channel:

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
   (enter `demo` and click **Connect**).

The demo producer also honors `DEMO_URL`, `DEMO_CHANNEL`, and
`DEMO_INTERVAL_MS` environment variables.

## Security

There is **no authentication**. Anyone who can reach the server can ingest
events and subscribe to channels. Run it only for **local or demo use**, or put
your own access control in front of it before exposing it.

## License

MIT
