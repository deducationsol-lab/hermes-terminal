import type { IncomingMessage, ServerResponse } from 'node:http';
import { backgroundStore, historyKey, riskDay } from './_lib/background';
export function historyQuery(url: string) {
  const params = new URL(url, 'http://localhost').searchParams;
  const day = params.get('day') || riskDay(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new Error('Invalid date');
  const offset = Number(params.get('offset') || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new Error('Invalid offset');
  return { day, offset };
}
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET') { res.statusCode = 405; res.end('{}'); return; }
  let query;
  try { query = historyQuery(req.url || '/'); }
  catch { res.statusCode = 400; res.end('{"error":"Invalid date or offset"}'); return; }
  try {
    const db = backgroundStore();
    const raw = await db.zrange(historyKey(query.day), query.offset, query.offset + 100);
    const events = raw.slice(0, 100).map(e => typeof e === 'string' ? JSON.parse(e) : e);
    res.end(JSON.stringify({ ...query, timezone: 'UTC-04:00', events,
      nextOffset: raw.length > 100 ? query.offset + 100 : null }));
  } catch { res.statusCode = 503; res.end('{"error":"History unavailable"}'); }
}
