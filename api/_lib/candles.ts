import { randomUUID } from 'node:crypto';
export interface Candle { time: number; open: number; close: number; high: number; low: number; volume: number; }
export function candleSignal(body: any, resolution: '1m' | '5m', now: number) {
  if (body?.code === 0 && typeof body?.data?.code === 'number') body = body.data;
  if (body?.code !== 0 || !Array.isArray(body?.data?.list)) throw new Error('Invalid candles');
  const seconds = resolution === '1m' ? 60 : 300;
  const candles: Candle[] = body.data.list.map((row: any) => Object.fromEntries(
    ['time', 'open', 'close', 'high', 'low', 'volume'].map((key) => [key, Number(row[key])])
  )).filter((c: Candle) => Object.values(c).every(Number.isFinite) && c.time > 0 &&
    c.time + seconds <= now / 1000 && c.open > 0 && c.close > 0 && c.low > 0 &&
    c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && c.volume >= 0)
    .sort((a: Candle, b: Candle) => a.time - b.time);
  if (candles.length < 21) return { qualified: false, resolution, reason: 'Need 21 closed valid candles' };
  const recent = candles.slice(-21);
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].time - recent[i - 1].time !== seconds) return { qualified: false, resolution, reason: 'Missing or duplicate candle' };
  }
  const c = recent[20], p = recent[19], p2 = recent[18], p3 = recent[17];
  const fresh = now / 1000 - (c.time + seconds) < seconds + 15;
  const declining = [p3, p2, p].every((x) => x.close < x.open) && p3.close > p2.close && p2.close > p.close;
  const engulfing = c.close > c.open && c.open <= p.close && c.close >= p.open &&
    (c.open < p.close || c.close > p.open);
  const average = recent.slice(0, 20).reduce((sum, x) => sum + x.volume, 0) / 20;
  return { qualified: fresh && declining && engulfing && c.volume > average,
    resolution, candleTime: c.time, closedAt: (c.time + seconds) * 1000,
    expiresAt: (c.time + 2 * seconds) * 1000, volume: c.volume, averageVolume: average,
    reason: fresh ? 'Closed bullish engulfing + three declining bearish candles + volume above prior 20 mean required' : 'Latest closed candle stale' };
}

export function createSignalFeed(request: typeof fetch = fetch, now = Date.now) {
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
            from: String(Math.floor(now() / 1000) - 26 * seconds), to: String(Math.floor(now() / 1000)),
            timestamp: String(Math.floor(now() / 1000)), client_id: randomUUID() }).forEach(([k, v]) => url.searchParams.set(k, v));
          const response = await request(url, { headers: { 'X-APIKEY': key }, signal: AbortSignal.timeout(8000) });
          if (!response.ok) {
            if (response.status === 429) cooldown = now() + 300000;
            console.warn('GMGN candle HTTP status', response.status);
            throw new Error('GMGN candles unavailable');
          }
          const body = await response.json();
          try { signals.push(candleSignal(body, resolution, now())); }
          catch {
            const inner = body?.data?.code !== undefined ? body.data : body;
            console.warn('GMGN candle schema', JSON.stringify({ code: typeof inner?.code === 'number' ? inner.code : 'non-numeric', keys: inner?.data && typeof inner.data === 'object' ? Object.keys(inner.data).slice(0, 8) : [] }));
            throw new Error('GMGN candles unavailable');
          }
        }
        const data = { address, chain: 'sol', fetchedAt: now(), signals };
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(address, { expires: now() + 45000, data });
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
