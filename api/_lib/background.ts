import { randomUUID } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { create, type AccountState } from '../../public/strategy';
import { createMarketFeed, type MarketSnapshot } from './gmgn';
import { createSignalFeed } from './candles';
import { fetchQuote } from '../quote';

export const STATE_KEY = 'hermes:paper:background:v1';
export const LOCK_KEY = STATE_KEY + ':lock';
export interface BackgroundState {
  version: 1; account: AccountState; watch: string[]; cursor: number; holdingCursor: number;
  seq: number; events: any[]; lastAttempt: number; lastSuccess: number | null;
  status: string; snapshot: ReturnType<ReturnType<typeof create>['snapshot']>;
}
export interface BackgroundStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: string, options: { nx: true; px: number }): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}
export function backgroundStore(): BackgroundStore {
  const direct = Boolean(process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_TOKEN);
  const url = direct ? process.env.UPSTASH_REDIS_REST_URL : process.env.KV_REST_API_URL;
  const token = direct ? process.env.UPSTASH_REDIS_REST_TOKEN : process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Background storage unavailable');
  return new Redis({ url, token });
}
// The lease outlives maxDuration. Fenced commit rejects workers whose lease expired.
export const COMMIT = `if redis.call('get', KEYS[1]) == ARGV[1] then
  redis.call('set', KEYS[2], ARGV[2]); redis.call('del', KEYS[1]); return 1 end return 0`;
export const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;
const marketFeed = createMarketFeed(), signalFeed = createSignalFeed();
export const liveFeeds = {
  market: () => marketFeed(process.env.GMGN_API_KEY || ''),
  quote: (address: string) => fetchQuote(address, process.env.GMGN_API_KEY || ''),
  signal: (address: string): Promise<{ signals: any[] }> => signalFeed(address, process.env.GMGN_API_KEY || '')
};
interface Feeds {
  market(): Promise<MarketSnapshot>;
  quote(address: string): Promise<{ price: number; fetchedAt: number; quoteSymbol?: string | null; highlightedQuote?: boolean }>;
  signal(address: string): Promise<{ signals: any[] }>;
}
export async function runBackground(db: BackgroundStore, feeds: Feeds = liveFeeds, now = Date.now) {
  const owner = randomUUID();
  if (!await db.set(LOCK_KEY, owner, { nx: true, px: 300000 })) return { skipped: 'overlap' };
  try {
    const saved = await db.get<BackgroundState>(STATE_KEY);
    if (saved && saved.version !== 1) throw new Error('Unsupported background state');
    // Duplicate deliveries in a minute do not process the same cycle again.
    if (saved && Math.floor(saved.lastAttempt / 60000) >= Math.floor(now() / 60000)) return { skipped: 'duplicate' };
    let state: BackgroundState;
    const pending: any[] = [];
    const emit = (agent: string, kind: string, address: string, message: string, meta: any) => {
      pending.push({ channel: 'solana-desk', level: agent === 'feed' || agent === 'risk' ? 'warn' : 'info',
        message: '[BACKGROUND · SIMULATED EXECUTION] ' + agent + ': ' + message,
        meta: { ...meta, mode: 'simulated-execution', source: 'GMGN', chain: 'sol', agent, kind, address, symbol: address, virtual: true }, ts: now() });
    };
    const account = create(emit, now, saved?.account);
    state = saved || { version: 1, account: account.exportState(), watch: [], cursor: 0, holdingCursor: 0,
      seq: 0, events: [], lastAttempt: 0, lastSuccess: null, status: 'Starting', snapshot: account.snapshot() };
    state.lastAttempt = now();
    if (!saved) emit('risk', 'rules', 'ACCOUNT', 'New persistent $10,000 virtual account. $500 maximum per buy including fees; same candle, stop and moonbag rules. Runs without an open tab. No real orders.', {});
    try {
      const data = await feeds.market();
      if (data.chain !== 'sol' || data.source !== 'GMGN' || !account.update(data.tokens, data.fetchedAt)) throw new Error('Stale market');
      state.watch = state.watch.filter(a => !account.excluded(a) && (account.holding(a) || data.tokens.some(t => t.address === a)));
      for (const token of data.tokens) {
        if (state.watch.length < 4 && !account.excluded(token.address) && !state.watch.includes(token.address)) {
          state.watch.push(token.address);
          emit('scout', 'watch', token.address, 'Watching ' + token.symbol + ' for a closed M1/M5 entry', token);
        }
      }
      if (!data.tokens.length) emit('scout', 'no-eligible-tokens', 'SCAN', 'No eligible tokens; strict filters unchanged. No fallback buys.', {});
      const missing = Object.keys(account.snapshot().positions).filter(a => !data.tokens.some(t => t.address === a));
      if (missing.length) {
        const address = missing[state.holdingCursor++ % missing.length];
        try {
          const quote = await feeds.quote(address);
          if (!account.update([{ address, price: quote.price }], quote.fetchedAt)) throw new Error('Stale quote');
          emit('scout', 'holding-quote', address, 'Refreshed holding outside the entry universe', quote);
        } catch { emit('feed', 'holding-unavailable', address, 'Holding quote unavailable; no invented exit.', {}); }
      } else {
        const candidates = state.watch.filter(a => !account.holding(a) && data.tokens.some(t => t.address === a));
        if (candidates.length) {
          const address = candidates[state.cursor++ % candidates.length];
          try {
            const quote = await feeds.quote(address);
            if (!account.update([{ address, price: quote.price }], quote.fetchedAt)) throw new Error('Stale quote');
            emit('scout', 'pair-check', address, 'GMGN-reported quote pair: ' + (quote.quoteSymbol || 'UNKNOWN'), quote);
            const result = await feeds.signal(address);
            const candidate = data.tokens.find(t => t.address === address)!;
            const eligible = candidate.ageMinutes + (now() - data.fetchedAt) / 60000 <= 500;
            const entered = eligible && result.signals.some(signal => account.enter(address, signal));
            if (!entered) emit('analyst', 'wait-entry', address, 'No qualified next-candle entry; minute scheduling may miss short windows.', {});
          } catch { emit('feed', 'candles-unavailable', address, 'Fresh quote or candles unavailable. No new entry.', {}); }
        }
      }
      state.lastSuccess = now();
      state.status = 'Scheduled paper trading active';
    } catch {
      state.status = 'GMGN unavailable — no fills without fresh data';
      emit('feed', 'paused', 'FEED', 'No fresh market snapshot. Positions retained; no synthetic fallback.', {});
    }
    state.account = account.exportState();
    state.snapshot = account.snapshot();
    emit('logger', 'account', 'ACCOUNT', 'Virtual equity $' + state.snapshot.equity.toFixed(2) + ' | P/L $' + state.snapshot.pnl.toFixed(2) + ' | cash $' + state.snapshot.cash.toFixed(2), state.snapshot);
    state.events = state.events.concat(pending.map(e => ({ ...e, seq: state.seq++ }))).slice(-500);
    if (!await db.eval(COMMIT, [LOCK_KEY, STATE_KEY], [owner, JSON.stringify(state)])) throw new Error('Lease lost; state not committed');
    console.info('Background paper cycle', JSON.stringify({ lastAttempt: state.lastAttempt, lastSuccess: state.lastSuccess,
      status: state.status, events: pending.length, positions: Object.keys(state.account.positions).length, seq: state.seq }));
    return { lastAttempt: state.lastAttempt, lastSuccess: state.lastSuccess, status: state.status, seq: state.seq };
  } finally { await db.eval(RELEASE, [LOCK_KEY], [owner]); }
}
