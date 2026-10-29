import { Redis } from '@upstash/redis';
import { randomUUID } from 'node:crypto';

interface GateStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: string | number, options: { nx?: true; px: number }): Promise<unknown>;
}
// Shared across market/candle functions and warm instances. Fail closed if the
// coordination store is unavailable; never risk a storm against the API key.
let redis: Redis | undefined;
function store(): GateStore {
  if (!redis) {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error('GMGN request pacing unavailable');
    redis = new Redis({ url, token });
  }
  return {
    get: (key) => redis!.get(key),
    set: (key, value, options) => options.nx
      ? redis!.set(key, value, { nx: true, px: options.px })
      : redis!.set(key, value, { px: options.px })
  };
}
export function createPacedRequest(getStore: () => GateStore = store, request: typeof fetch = fetch,
  now = Date.now, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://openapi.gmgn.ai' || !['/v1/market/rank', '/v1/market/token_kline', '/v1/token/info'].includes(url.pathname) ||
        (init?.method && init.method !== 'GET')) throw new Error('GMGN route not allowed');
    const db = getStore(), deadline = now() + 25000;
    while (true) {
      if (await db.get('hermes:gmgn:cooldown')) throw new Error('GMGN rate cooldown');
      const acquired = await db.set('hermes:gmgn:request-slot', '1', { nx: true, px: 10000 });
      if (acquired) break;
      if (now() >= deadline) throw new Error('GMGN request queue busy');
      await sleep(1000);
    }
    // Authentication timestamps expire quickly: refresh only after queueing.
    url.searchParams.set('timestamp', String(Math.floor(now() / 1000)));
    url.searchParams.set('client_id', randomUUID());
    const response = await request(url, { ...init, signal: AbortSignal.timeout(8000) });
    if (response.status === 429 || response.status === 403) {
      const header = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      const until = response.status === 403 ? now() + 3600000 : Math.max(now() + 300000, Number.isFinite(header) ? header : 0);
      await db.set('hermes:gmgn:cooldown', until, { px: Math.min(86400000, Math.max(300000, until - now())) });
      console.warn('GMGN shared cooldown', JSON.stringify({ status: response.status, retryAt: new Date(until).toISOString() }));
    }
    return response;
  };
}
export const gmgnRequest = createPacedRequest();
