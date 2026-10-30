import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { backgroundStore, runBackground } from './_lib/background';
export function authorized(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const a = Buffer.from(header), b = Buffer.from('Bearer ' + secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET') { res.statusCode = 405; res.end('{}'); return; }
  if (process.env.VERCEL_ENV !== 'production' || !authorized(req.headers.authorization, process.env.CRON_SECRET)) {
    res.statusCode = 401; res.end('{"error":"Unauthorized"}'); return;
  }
  if (!process.env.GMGN_API_KEY) { res.statusCode = 503; res.end('{"error":"GMGN not configured"}'); return; }
  try { res.end(JSON.stringify(await runBackground(backgroundStore()))); }
  catch { res.statusCode = 503; res.end('{"error":"Background cycle unavailable"}'); }
}
