/**
 * Vercel serverless liveness probe.
 *
 * Returns a small 200 JSON body so you can confirm the deployment itself is up
 * and routing to the serverless functions, independent of any backing store.
 *
 * Unlike api/ingest.ts and api/stream.ts this handler is dependency-free and
 * does NOT resolve Upstash Redis, so it answers even before the
 * UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN env vars are configured.
 * That makes it useful as the first check after a fresh deploy. It is the
 * serverless analog of GET /healthz in src/server.ts.
 *
 * Strictly domain-agnostic.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The health handler. Responds 200 with `{ "status": "ok" }` to GET (and HEAD);
 * any other method gets 405.
 */
export function handleHealthz(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  const body = JSON.stringify({ status: 'ok' });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

/** Vercel default export: (req, res) signature. */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  handleHealthz(req, res);
}
