/**
 * Vercel serverless Server-Sent Events (SSE) function.
 *
 * On Vercel the live transport is SSE, not WebSocket, because Vercel does not
 * run long-lived WebSocket servers. This handler replays recent history for a
 * channel, then tails new events and pushes them to the browser as SSE.
 *
 * WHY POLLING-BY-SEQ INSTEAD OF REDIS PUB/SUB:
 * The @upstash/redis client is a connectionless HTTP/REST client. It cannot
 * hold a blocking Redis SUBSCRIBE open across a serverless invocation, so true
 * pub/sub fan-out is not available over REST on Vercel. Instead we implement
 * live tailing: we periodically re-read the per-channel trimmed list and
 * forward only events whose seq is greater than the last-seen seq. This gives
 * the same observable behavior (new events arrive live) using only REST calls,
 * at the cost of a small polling latency. The list is capped (see LIST_CAP), so
 * each poll reads at most that many entries.
 *
 * SSE framing (kept consistent with the WebSocket protocol in src/server.ts and
 * the frontend parser):
 *  - one initial `data:` message `{ type: 'history', events: LogEvent[] }`
 *  - one `data:` message per subsequent event `{ type: 'event', event: LogEvent }`
 *  - `:` comment lines as idle heartbeats to keep proxies from closing the
 *    connection.
 *
 * Strictly domain-agnostic.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { LogEvent } from '../src/types';
import { resolveRedis, type RedisLike } from './_lib/redis';
import { readHistory } from './_lib/store';

/** Channel used when a client connects without ?channel=NAME. */
const DEFAULT_CHANNEL = 'demo';

/** How often (ms) we re-read the list to tail new events. */
const POLL_INTERVAL_MS = 1000;

function writeSseData(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeHeartbeat(res: ServerResponse): void {
  res.write(': heartbeat\n\n');
}

/**
 * The SSE stream handler.
 *
 * @param redis Optional injected Redis client; tests pass a mock so no live
 *   connection is required. In production it is resolved from the environment.
 */
export function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  redis?: RedisLike,
): void {
  if ((req.method ?? 'GET') !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const channel = url.searchParams.get('channel') || DEFAULT_CHANNEL;

  let client: RedisLike;
  try {
    client = resolveRedis(redis);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: (err as Error).message }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Defeat proxy/load-balancer response buffering so events flush promptly.
    'x-accel-buffering': 'no',
  });

  // Track the highest seq delivered so each poll forwards only newer events.
  let lastSeenSeq = -1;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
  };

  // Clean up the polling timer when the client disconnects so we do not leak.
  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('close', cleanup);

  const forward = (events: LogEvent[]): void => {
    for (const event of events) {
      if (event.seq > lastSeenSeq) {
        lastSeenSeq = event.seq;
      }
    }
  };

  void (async () => {
    // Replay recent history once, as a single tagged envelope.
    try {
      const history = await readHistory(client, channel);
      if (closed) return;
      writeSseData(res, { type: 'history', events: history });
      forward(history);
    } catch {
      // Ignore a failed initial read; the poll loop will retry.
    }

    if (closed) return;

    // Poll the list and forward only events newer than lastSeenSeq. Emit a
    // heartbeat comment on idle ticks so proxies keep the connection open.
    timer = setInterval(() => {
      void (async () => {
        if (closed) return;
        let fresh: LogEvent[] = [];
        try {
          const all = await readHistory(client, channel);
          fresh = all.filter((event) => event.seq > lastSeenSeq);
        } catch {
          return;
        }
        if (closed) return;
        if (fresh.length === 0) {
          writeHeartbeat(res);
          return;
        }
        for (const event of fresh) {
          writeSseData(res, { type: 'event', event });
          if (event.seq > lastSeenSeq) lastSeenSeq = event.seq;
        }
      })();
    }, POLL_INTERVAL_MS);
  })();
}

/** Vercel default export: (req, res) signature. */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  handleStream(req, res);
}
