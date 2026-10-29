import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMarketFeed } from './_lib/gmgn';
const feed = createMarketFeed();
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'Method not allowed' })); return; }
  const key = process.env.GMGN_API_KEY;
  if (!key) { res.statusCode = 503; res.end(JSON.stringify({ error: 'GMGN feed not configured; simulated execution paused' })); return; }
  try {
    const data = await feed(key);
    res.setHeader('cache-control', 'public, s-maxage=20');
    res.end(JSON.stringify(data));
  } catch {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'GMGN feed unavailable; simulated execution paused' }));
  }
}
