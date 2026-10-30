import { gmgnRequest } from './gmgn-request';
import { randomUUID } from 'node:crypto';
export interface Candle { time: number; open: number; close: number; high: number; low: number; volume: number; }
export function candleSignal(body: any, resolution: '1m' | '5m', now: number) {
  if (body?.code === 0 && typeof body?.data?.code === 'number') body = body.data;
  if (body?.code !== 0 || !Array.isArray(body?.data?.list)) throw new Error('Invalid candles');
  const seconds = resolution === '1m' ? 60 : 300;
  const candles: Candle[] = body.data.list.map((row: any) => Object.fromEntries(
    ['time', 'open', 'close', 'high', 'low', 'volume'].map((key) => [key, Number(row[key])])
  )).map((c: Candle) => ({ ...c, time: c.time > 1e12 ? c.time / 1000 : c.time }));
  // Only the immediately preceding closed bar may trigger an entry in this bar.
  // Do not filter invalid OHLC first: that could resurrect an older pattern.
  const candleTime = (Math.floor(now / 1000 / seconds) - 1) * seconds;
  const latest = candles.filter((c) => c.time === candleTime);
  const valid = (c: Candle) => [c.open, c.close, c.high, c.low].every(Number.isFinite) &&
    c.open > 0 && c.close > 0 && c.low > 0 &&
    c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close);
  if (latest.length !== 1 || !valid(latest[0])) return { qualified: false, resolution,
    reason: 'Need one valid latest closed candle; missing, duplicate or stale candle' };
  const c = latest[0];
  const previous = candles.filter((p) => p.time === candleTime - seconds);
  const p = previous.length === 1 && valid(previous[0]) ? previous[0] : null;
  const engulfing = p !== null && p.close < p.open && c.close > c.open &&
    c.open <= p.close && c.close >= p.open && (c.open < p.close || c.close > p.open);
  // Either candle color is valid; dojis and long wicks on both sides are not.
  const bodySize = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const hammer = resolution === '1m' && bodySize > 0 &&
    lowerWick >= 2 * bodySize && upperWick <= bodySize / 2;
  const invertedHammer = resolution === '1m' && bodySize > 0 &&
    upperWick >= 2 * bodySize && lowerWick <= bodySize / 2;
  const pattern = engulfing ? 'bullish-engulfing' : hammer ? 'hammer' : invertedHammer ? 'inverted-hammer' : null;
  return { qualified: pattern !== null, resolution, pattern, candleTime: c.time,
    closedAt: (c.time + seconds) * 1000, expiresAt: (c.time + 2 * seconds) * 1000,
    reason: pattern ? 'Enter during the next candle after either closed pattern' :
      'Need latest M1 hammer/inverted hammer OR last two M1/M5 candles bullish engulfing' };
}

export function createSignalFeed(request: typeof fetch = gmgnRequest, now = Date.now) {
  const cache = new Map<string, { expires: number; data: any }>();
  const pending = new Map<string, Promise<any>>();
  let cooldown = 0;
  return async (address: string, key: string) => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new Error('Invalid mint');
    const saved = cache.get(address);
    if (saved && saved.expires > now()) return saved.data;
    if (pending.has(address)) return pending.get(address)!;
    if (now() < cooldown) throw new Error('Feed cooling down');
    const task = (async () => {
      try {
        const signals = [];
        for (const resolution of ['1m', '5m'] as const) {
          const url = new URL('https://openapi.gmgn.ai/v1/market/token_kline');
          const seconds = resolution === '1m' ? 60 : 300;
          Object.entries({ chain: 'sol', address, resolution,
            from: String(now() - 26 * seconds * 1000), to: String(now()),
            timestamp: String(Math.floor(now() / 1000)), client_id: randomUUID() }).forEach(([k, v]) => url.searchParams.set(k, v));
          const response = await request(url, { headers: { 'X-APIKEY': key }, signal: AbortSignal.timeout(8000) });
          if (!response.ok) {
            if (response.status === 429) cooldown = now() + 300000;
            console.warn('GMGN candle HTTP status', response.status);
            throw new Error('GMGN candles unavailable');
          }
          const body = await response.json();
          try {
            const signal = candleSignal(body, resolution, now());
            signals.push(signal);
            if (signal.qualified) break; // Either timeframe suffices; no second confirmation.
          }
          catch {
            const inner = body?.data?.code !== undefined ? body.data : body;
            console.warn('GMGN candle schema', JSON.stringify({ code: typeof inner?.code === 'number' ? inner.code : 'non-numeric', keys: inner?.data && typeof inner.data === 'object' ? Object.keys(inner.data).slice(0, 8) : [] }));
            throw new Error('GMGN candles unavailable');
          }
        }
        const data = { address, chain: 'sol', fetchedAt: now(), signals };
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(address, { expires: Math.min(now() + 45000, (Math.floor(now() / 60000) + 1) * 60000), data });
        return data;
      } catch {
        cooldown = Math.max(cooldown, now() + 60000);
        throw new Error('GMGN candles unavailable');
      }
    })();
    pending.set(address, task);
    try { return await task; } finally { pending.delete(address); }
  };
}
