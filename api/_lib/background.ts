import { randomUUID } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { create, type AccountState } from '../../public/strategy';
import { createMarketFeed, type MarketSnapshot } from './gmgn';
import { createSignalFeed } from './candles';
import { fetchQuote } from '../quote';

export const STATE_KEY = 'hermes:paper:background:v1';
export function riskDay(ts: number) { return new Date(ts - 4 * 3600000).toISOString().slice(0, 10); }
export function historyKey(day: string) { return 'hermes:paper:history:v1:' + day; }
export const LOCK_KEY = STATE_KEY + ':lock';
export interface BackgroundState {
  historyArchived?: boolean;
  version: 1; account: AccountState; watch: string[]; cursor: number; holdingCursor: number;
  seq: number; events: any[]; lastAttempt: number; lastSuccess: number | null;
  status: string; snapshot: ReturnType<ReturnType<typeof create>['snapshot']>;
}
export interface BackgroundStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: string, options: { nx: true; px: number }): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}
export function backgroundStore(): Redis {
  const direct = Boolean(process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_TOKEN);
  const url = direct ? process.env.UPSTASH_REDIS_REST_URL : process.env.KV_REST_API_URL;
  const token = direct ? process.env.UPSTASH_REDIS_REST_TOKEN : process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Background storage unavailable');
  return new Redis({ url, token });
}
// The lease outlives maxDuration. Fenced commit rejects workers whose lease expired.
export const COMMIT = `if redis.call('get', KEYS[1]) == ARGV[1] then
  local groups = cjson.decode(ARGV[3])
  for _, group in ipairs(groups) do
    for _, event in ipairs(group.events) do
      redis.call('zadd', KEYS[group.key], 'NX', event.seq, event.json)
    end
  end
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
  quote(address: string): Promise<{ price: number; marketCap?: number | null; fetchedAt: number; quoteSymbol?: string | null; highlightedQuote?: boolean }>;
  signal(address: string): Promise<{ signals: any[] }>;
}
export async function runBackground(db: BackgroundStore, feeds: Feeds = liveFeeds, now = Date.now) {
  const owner = randomUUID();
  if (!await db.set(LOCK_KEY, owner, { nx: true, px: 300000 })) return { skipped: 'overlap' };
  try {
    const saved = await db.get<BackgroundState>(STATE_KEY);
    if (saved && saved.version !== 1) throw new Error('Unsupported background state');
    // Minimum start spacing across workers, cron retries and duplicate deliveries.
    if (saved && now() - saved.lastAttempt < 30000) return { skipped: 'duplicate' };
    let state: BackgroundState;
    const pending: any[] = [];
    const emit = (agent: string, kind: string, address: string, message: string, meta: any) => {
      pending.push({ channel: 'solana-desk', level: agent === 'feed' || agent === 'risk' ? 'warn' : 'info',
        message: '[BACKGROUND · SIMULATED EXECUTION] ' + agent + ': ' + message,
        meta: { ...meta, mode: 'simulated-execution', source: 'GMGN', chain: 'sol', agent, kind, address, symbol: address, virtual: true }, ts: now() });
    };
    // Recover legacy fixed anchors from retained take-profit fills when available.
    if (saved) {
      for (const [address, position] of Object.entries(saved.account.positions)) {
        if (!position.moonbag || Number.isFinite(position.moonbagPrice)) continue;
        const event = saved.events.find(e => e.meta?.address === address && e.meta?.kind === 'take-profit-50');
        if (Number.isFinite(event?.meta?.fill) && event.meta.fill > 0) position.moonbagPrice = event.meta.fill / (1 - 0.0005);
      }
    }
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
          if (!account.update([{ address, price: quote.price, marketCap: quote.marketCap }], quote.fetchedAt)) throw new Error('Stale quote');
          emit('scout', 'holding-quote', address, 'Refreshed holding outside the entry universe', quote);
        } catch { emit('feed', 'holding-unavailable', address, 'Holding quote unavailable; no invented exit.', {}); }
      } else {
        const candidates = state.watch.filter(a => !account.holding(a) && data.tokens.some(t => t.address === a));
        if (candidates.length) {
          const address = candidates[state.cursor++ % candidates.length];
          try {
            const quote = await feeds.quote(address);
            if (!account.update([{ address, price: quote.price, marketCap: quote.marketCap }], quote.fetchedAt)) throw new Error('Stale quote');
            emit('scout', 'pair-check', address, 'GMGN-reported quote pair: ' + (quote.quoteSymbol || 'UNKNOWN'), quote);
            const result = await feeds.signal(address);
            const candidate = data.tokens.find(t => t.address === address)!;
            const eligible = Number.isFinite(quote.marketCap) && quote.marketCap! >= 5000 && candidate.ageMinutes + (now() - data.fetchedAt) / 60000 <= 500;
            const entered = eligible && result.signals.some(signal => account.enter(address, signal));
            if (!entered) emit('analyst', 'wait-entry', address, 'No qualified next-candle entry; minute scheduling may miss short windows.', {});
          } catch { emit('feed', 'candles-unavailable', address, 'Fresh quote or candles unavailable. No new entry.', {}); }
        }
      }
      state.lastSuccess = now();
      state.status = account.snapshot().daily.paused ? 'Daily loss limit — new buys paused until next UTC−4 day' : 'Scheduled paper trading active';
    } catch {
      state.status = 'GMGN unavailable — no fills without fresh data';
      emit('feed', 'paused', 'FEED', 'No fresh market snapshot. Positions retained; no synthetic fallback.', {});
    }
    state.account = account.exportState();
    state.snapshot = account.snapshot();
    emit('logger', 'account', 'ACCOUNT', 'Virtual equity $' + state.snapshot.equity.toFixed(2) + ' | P/L $' + state.snapshot.pnl.toFixed(2) + ' | cash $' + state.snapshot.cash.toFixed(2), state.snapshot);
    const newEvents = pending.map(e => ({ ...e, seq: state.seq++ }));
    const archiveEvents = state.historyArchived ? newEvents : state.events.concat(newEvents);
    const groups = new Map<string, any[]>();
    for (const event of archiveEvents) {
      if (!Number.isFinite(event.ts) || !Number.isFinite(event.seq)) continue;
      const day = riskDay(event.ts);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day)!.push({ seq: event.seq, json: JSON.stringify(event) });
    }
    state.historyArchived = true;
    state.events = state.events.concat(newEvents).slice(-500);
    const days = [...groups.keys()];
    const batch = days.map((day, i) => ({ key: i + 3, events: groups.get(day) }));
    if (!await db.eval(COMMIT, [LOCK_KEY, STATE_KEY, ...days.map(historyKey)], [owner, JSON.stringify(state), JSON.stringify(batch)])) throw new Error('Lease lost; state not committed');
    console.info('Background paper cycle', JSON.stringify({ lastAttempt: state.lastAttempt, lastSuccess: state.lastSuccess,
      status: state.status, events: pending.length, positions: Object.keys(state.account.positions).length, tradedMints: Object.keys(state.account.traded || {}).length,
      blockedMints: Object.keys(state.account.excluded).length, daily: state.snapshot.daily, archivedEvents: archiveEvents.length, seq: state.seq }));
    return { lastAttempt: state.lastAttempt, lastSuccess: state.lastSuccess, status: state.status, seq: state.seq };
  } finally { await db.eval(RELEASE, [LOCK_KEY], [owner]); }
}
