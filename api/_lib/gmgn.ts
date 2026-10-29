import { randomUUID } from 'node:crypto';

export interface MarketToken {
  address: string; symbol: string; price: number; marketCap: number; liquidity: number;
}
export interface MarketSnapshot { chain: 'sol'; source: 'GMGN'; fetchedAt: number; tokens: MarketToken[]; }

export function normalizeRank(body: any): MarketToken[] {
  if (body?.code !== 0 || !Array.isArray(body?.data?.rank)) throw new Error('Invalid GMGN response');
  const seen = new Set<string>();
  return body.data.rank.flatMap((item: any) => {
    const price = Number(item.price), marketCap = Number(item.market_cap), liquidity = Number(item.liquidity);
    if (item.chain !== 'sol' || typeof item.address !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(item.address) || seen.has(item.address) ||
        !Number.isFinite(price) || price <= 0 || !Number.isFinite(marketCap) ||
        marketCap < 100000 || marketCap > 10000000 || !Number.isFinite(liquidity) || liquidity < 50000) return [];
    seen.add(item.address);
    return [{ address: item.address, symbol: String(item.symbol || 'TOKEN').slice(0, 24), price, marketCap, liquidity }];
  }).slice(0, 12);
}

// One read-only upstream route, no client-controlled URL, and no swap/signing code.
export function createMarketFeed(request: typeof fetch = fetch, now = Date.now) {
  let cache: MarketSnapshot | null = null;
  let inFlight: Promise<MarketSnapshot> | null = null;
  let retryAfter = 0;
  return async (key: string): Promise<MarketSnapshot> => {
    if (cache && now() - cache.fetchedAt < 20000) return cache;
    if (inFlight) return inFlight;
    if (now() < retryAfter) throw new Error('GMGN temporarily unavailable');
    inFlight = (async () => {
      const url = new URL('https://openapi.gmgn.ai/v1/market/rank');
      Object.entries({ chain: 'sol', interval: '1h', limit: '100', order_by: 'volume', direction: 'desc',
        min_marketcap: '100000', max_marketcap: '10000000', min_liquidity: '50000',
        timestamp: String(Math.floor(now() / 1000)), client_id: randomUUID() }).forEach(([k, v]) => url.searchParams.set(k, v));
      url.searchParams.append('filters', 'not_risk');
      url.searchParams.append('filters', 'not_honeypot');
      try {
        const response = await request(url, { headers: { 'X-APIKEY': key }, signal: AbortSignal.timeout(10000) });
        if (!response.ok) {
          console.warn('GMGN market HTTP status', response.status);
          throw new Error('GMGN unavailable');
        }
        const body = await response.json();
        if (body?.code !== 0 || !Array.isArray(body?.data?.rank)) {
          console.warn('GMGN market response schema', JSON.stringify({ code: typeof body?.code === 'number' ? body.code : 'non-numeric', hasRank: Array.isArray(body?.data?.rank), dataArray: Array.isArray(body?.data), dataKeys: body?.data && typeof body.data === 'object' ? Object.keys(body.data).slice(0, 12) : [] }));
        }
        const tokens = normalizeRank(body);
        cache = { chain: 'sol', source: 'GMGN', fetchedAt: now(), tokens };
        return cache;
      } catch (error) {
        const name = error instanceof Error ? error.name : 'UnknownError';
        console.warn('GMGN market request failed', name);
        retryAfter = now() + 20000;
        throw new Error('GMGN unavailable');
      }
    })();
    try { return await inFlight; } finally { inFlight = null; }
  };
}
