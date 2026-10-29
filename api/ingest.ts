/**
 * Vercel serverless ingest function.
 *
 * Accepts a JSON log event from a producer over POST, validates it with the
 * shared pure logic (the same rules as the local node:http server), assigns a
 * server-side monotonic seq, appends it to the per-channel Upstash list, trims
 * that list to the recent-history cap, and echoes the stored event.
 *
 * This is the serverless analog of POST /ingest in src/server.ts. The handler
 * is typed against node:http (IncomingMessage/ServerResponse), which the Vercel
 * Node runtime is compatible with, so no extra dependency is required.
 *
 * Strictly domain-agnostic.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { MAX_BODY_BYTES, validateIngest } from './_lib/validate';
import { resolveRedis, type RedisLike } from './_lib/redis';
import { appendEvent } from './_lib/store';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Read a request body as a UTF-8 string, capped to MAX_BODY_BYTES. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The ingest handler.
 *
 * @param redis Optional injected Redis client; tests pass a mock so no live
 *   connection is required. In production it is resolved from the environment.
 */
export async function handleIngest(
  req: IncomingMessage,
  res: ServerResponse,
  redis?: RedisLike,
): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid request body' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'invalid JSON' });
    return;
  }

  const result = validateIngest(parsed);
  if (!result.ok) {
    sendJson(res, result.error.status, { error: result.error.error });
    return;
  }

  let client: RedisLike;
  try {
    client = resolveRedis(redis);
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message });
    return;
  }

  const event = await appendEvent(client, result.payload, Date.now());
  sendJson(res, 200, event);
}

/** Vercel default export: (req, res) signature. */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  void handleIngest(req, res);
}
