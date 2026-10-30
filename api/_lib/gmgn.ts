import { gmgnRequest } from './gmgn-request';
import { randomUUID } from 'node:crypto';

export type TrendingWindow = '5m' | '1h';
export interface MarketToken {
  address: string; symbol: string; price: number; marketCap: number; liquidity: number;
  volume: number; top10Percent: number; ageMinutes: number; socialCount: number;
  mintRevoked: true; freezeRevoked: true; lpBurned: true;
  trending: TrendingWindow[]; volumes: Partial<Record<TrendingWindow, number>>;
}
export interface MarketSnapshot { chain: 'sol'; source: 'GMGN'; fetchedAt: number; tokens: MarketToken[]; }

// Do not coerce null, booleans or blank fields into passing numeric values.
function numeric(value: unknown): number {
  return (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
}
function revoked(value: unknown): boolean { return value === 1 || value === '1' || value === true; }
function socialCount(item: any): number {
  const twitter = typeof item.twitter_username === 'string' && /^@?[A-Za-z0-9_]{1,15}$/.test(item.twitter_username.trim());
  const telegram = typeof item.telegram === 'string' && /^https:\/\/(t\.me|telegram\.me)\/[^\s/]+/i.test(item.telegram.trim());
  const website = typeof item.website === 'string' && /^https?:\/\/[^\s/]+\.[^\s/]+/i.test(item.website.trim());
  return Number(Boolean(twitter)) + Number(Boolean(telegram)) + Number(Boolean(website));
}
export function normalizeRank(body: any, now = Date.now(), interval: TrendingWindow = '5m'): MarketToken[] {
  if (body?.code === 0 && body?.data && typeof body.data.code === 'number') body = body.data;
  if (body?.code !== 0 || !Array.isArray(body?.data?.rank)) throw new Error('Invalid GMGN response');
  const seen = new Set<string>();
  return body.data.rank.flatMap((item: any) => {
    if (!item || typeof item !== 'object') return [];
    const price = numeric(item.price), marketCap = numeric(item.market_cap), liquidity = numeric(item.liquidity);
    const volume = numeric(item.volume), rate = numeric(item.top_10_holder_rate);
    const created = numeric(item.creation_timestamp), ageMinutes = (now / 1000 - created) / 60;
    const socials = socialCount(item);
    if (item.chain !== 'sol' || typeof item.address !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(item.address) || seen.has(item.address) ||
        !Number.isFinite(price) || price <= 0 || !Number.isFinite(marketCap) || marketCap < 5000 ||
        !Number.isFinite(liquidity) || liquidity < 1500 || !Number.isFinite(volume) || volume < 1000 ||
        !Number.isFinite(rate) || rate < 0.12 || rate > 0.28 ||
        !Number.isFinite(created) || created <= 0 || ageMinutes < 0 || ageMinutes > 500 || socials < 1 ||
        !revoked(item.renounced_mint) || !revoked(item.renounced_freeze_account) || item.burn_status !== 'burn') return [];
    seen.add(item.address);
    return [{ address: item.address, symbol: String(item.symbol || 'TOKEN').slice(0, 24), price, marketCap, liquidity,
      volume, top10Percent: rate * 100, ageMinutes, socialCount: socials,
      mintRevoked: true as const, freezeRevoked: true as const, lpBurned: true as const,
      trending: [interval], volumes: { [interval]: volume } }];
  });
}

// One read-only upstream route, no client-controlled URL, and no swap/signing code.
export function createMarketFeed(request: typeof fetch = gmgnRequest, now = Date.now) {
  let cache: MarketSnapshot | null = null;
  let inFlight: Promise<MarketSnapshot> | null = null;
  let retryAfter = 0;
  return async (key: string): Promise<MarketSnapshot> => {
    if (cache && now() - cache.fetchedAt < 20000) {
      const elapsed = (now() - cache.fetchedAt) / 60000;
      return { ...cache, tokens: cache.tokens.map((token) => ({ ...token, ageMinutes: token.ageMinutes + elapsed }))
        .filter((token) => token.ageMinutes <= 500) };
    }
    if (inFlight) return inFlight;
    if (now() < retryAfter) throw new Error('GMGN temporarily unavailable');
    inFlight = (async () => {
      try {
        // Select raw rank positions before filtering. Never backfill from rank 21+.
        const url = new URL('https://openapi.gmgn.ai/v1/market/rank');
        Object.entries({ chain: 'sol', interval: '5m', limit: '20', order_by: 'volume', direction: 'desc',
          timestamp: String(Math.floor(now() / 1000)), client_id: randomUUID() }).forEach(([k, v]) => url.searchParams.set(k, v));
        const response = await request(url, { headers: { 'X-APIKEY': key }, signal: AbortSignal.timeout(10000) });
        if (!response.ok) {
          console.warn('GMGN market HTTP status', response.status);
          throw new Error('GMGN unavailable');
        }
        let body = await response.json();
        if (body?.code === 0 && typeof body?.data?.code === 'number') body = body.data;
        if (body?.code !== 0 || !Array.isArray(body?.data?.rank)) throw new Error('Invalid GMGN ranking');
        const tokens = normalizeRank({ code: 0, data: { rank: body.data.rank.slice(0, 20) } }, now(), '5m');
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
