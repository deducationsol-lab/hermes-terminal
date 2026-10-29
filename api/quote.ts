import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { gmgnRequest } from './_lib/gmgn-request';

export function normalizeQuote(body: any, address: string, fetchedAt: number) {
  if (body?.code === 0 && typeof body?.data?.code === 'number') body = body.data;
  const token = body?.data;
  const price = Number(token?.price?.price);
  if (body?.code !== 0 || !Number.isFinite(price) || price <= 0 ||
      (token.chain && token.chain !== 'sol') || (token.address && token.address !== address)) throw new Error('Invalid price');
  return { chain: 'sol', address, price, fetchedAt };
}
const cache = new Map<string, ReturnType<typeof normalizeQuote>>();
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET') { res.statusCode = 405; res.end('{}'); return; }
  const address = new URL(req.url || '/', 'http://localhost').searchParams.get('address') || '';
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) { res.statusCode = 400; res.end('{}'); return; }
  const key = process.env.GMGN_API_KEY;
  if (!key) { res.statusCode = 503; res.end('{}'); return; }
  try {
    let data = cache.get(address);
    if (!data || Date.now() - data.fetchedAt > 20000) {
      const url = new URL('https://openapi.gmgn.ai/v1/token/info');
      Object.entries({ chain: 'sol', address, timestamp: String(Math.floor(Date.now() / 1000)), client_id: randomUUID() }).forEach(([k, v]) => url.searchParams.set(k, v));
      const response = await gmgnRequest(url, { headers: { 'X-APIKEY': key } });
      if (!response.ok) throw new Error('Unavailable');
      data = normalizeQuote(await response.json(), address, Date.now());
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(address, data);
    }
    res.end(JSON.stringify(data));
  } catch { res.statusCode = 503; res.end(JSON.stringify({ error: 'Holding quote unavailable; no simulated exit' })); }
}
