import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSignalFeed } from './_lib/candles';
const feed = createSignalFeed();
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET') { res.statusCode = 405; res.end('{}'); return; }
  const address = new URL(req.url || '/', 'http://localhost').searchParams.get('address') || '';
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) { res.statusCode = 400; res.end('{}'); return; }
  if (!process.env.GMGN_API_KEY) { res.statusCode = 503; res.end('{}'); return; }
  try { res.end(JSON.stringify(await feed(address, process.env.GMGN_API_KEY))); }
  catch { res.statusCode = 503; res.end(JSON.stringify({ error: 'Candle feed unavailable; entries paused' })); }
}
