import { addActivity, type Activity } from './dashboard';
import { randomUUID } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { create, type AccountState } from '../../public/strategy';
import { createMarketFeed, type MarketSnapshot } from './gmgn';
import { createSignalFeed } from './candles';
import { pollWallet, FOLLOW_WALLET, type WalletState } from './helius';
import { fetchQuote } from '../quote';

export const FOLLOW_POLICY_EPOCH = 'omniverse-fresh-2026-10-30-v1';
export const STATE_KEY = 'hermes:paper:background:v1';
export function riskDay(ts: number) { return new Date(ts - 4 * 3600000).toISOString().slice(0, 10); }
export function historyKey(day: string) { return 'hermes:paper:history:v1:' + day; }
export const LOCK_KEY = STATE_KEY + ':lock';
export interface BackgroundState {
  activity?: Activity;
  tokenNames?: Record<string, string>;
  policyEpoch?: string;
  wallet?: WalletState;
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
  wallet: pollWallet,
  market: () => marketFeed(process.env.GMGN_API_KEY || ''),
  quote: (address: string) => fetchQuote(address, process.env.GMGN_API_KEY || ''),
  signal: (address: string): Promise<{ signals: any[] }> => signalFeed(address, process.env.GMGN_API_KEY || '')
};
interface Feeds {
  wallet?(state: WalletState): Promise<WalletState>;
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
        meta: { ...meta, mode: 'simulated-execution', source: 'GMGN', chain: 'sol', agent, kind, address, symbol: meta?.tokenSymbol || address, virtual: true }, ts: now() });
    };
    // Recover legacy fixed anchors from retained take-profit fills when available.
    if (saved) {
      for (const [address, position] of Object.entries(saved.account.positions)) {
        if (!position.moonbag || Number.isFinite(position.moonbagPrice)) continue;
        const event = saved.events.find(e => e.meta?.address === address && e.meta?.kind === 'take-profit-50');
        if (Number.isFinite(event?.meta?.fill) && event.meta.fill > 0) position.moonbagPrice = event.meta.fill / (1 - 0.0005);
      }
    }
    const reset = Boolean(feeds.wallet && saved?.policyEpoch !== FOLLOW_POLICY_EPOCH);
    if (reset) emit('risk', 'account-reset', 'ACCOUNT', 'User-authorized fresh $10,000 paper account. Previous positions cleared without simulated liquidation; history retained.',
      { previousSnapshot: saved?.snapshot || null, epoch: FOLLOW_POLICY_EPOCH });
    const account = create(emit, now, reset ? undefined : saved?.account,
      feeds.wallet ? { repeatBuys: true, noDailyPause: true, unfilteredEntries: true } : undefined);
    state = saved || { version: 1, account: account.exportState(), watch: [], cursor: 0, holdingCursor: 0,
      seq: 0, events: [], lastAttempt: 0, lastSuccess: null, status: 'Starting', snapshot: account.snapshot() };
    if (reset) {
      state.policyEpoch = FOLLOW_POLICY_EPOCH;
      state.watch = []; state.cursor = 0; state.holdingCursor = 0;
      state.wallet = { activatedAt: now(), through: Math.floor(now() / 1000), lastRead: 0, seen: [], queue: [], observed: 0 };
    }
    state.lastAttempt = now();
    if (!saved) emit('risk', 'rules', 'ACCOUNT', 'New persistent $10,000 virtual account. $500 maximum per buy including fees; same candle, stop and moonbag rules. Runs without an open tab. No real orders.', {});
    let walletReady = !feeds.wallet;
    if (feeds.wallet) {
      state.wallet ||= { activatedAt: now(), through: Math.floor(now() / 1000), lastRead: 0, seen: [], queue: [], observed: 0 };
      try {
        state.wallet = await feeds.wallet(state.wallet); walletReady = state.wallet.lastRead > 0;
        emit('scout', 'wallet-poll', 'WALLET', 'Helius confirmed wallet activity read; only new supported swaps eligible.',
          { wallet: FOLLOW_WALLET, scanned: state.wallet.scanned, observed: state.wallet.observed, queued: state.wallet.queue.length, lastRead: state.wallet.lastRead, behavior: state.wallet.behavior });
      } catch {
        emit('feed', 'wallet-unavailable', 'WALLET', 'Helius unavailable or backlog incomplete. No wallet entries; existing protective exits continue.', {});
      }
    }
    try {
      const data = feeds.wallet ? { chain: 'sol', source: 'GMGN', fetchedAt: now(), tokens: [] } as MarketSnapshot : await feeds.market();
      if (data.chain !== 'sol' || data.source !== 'GMGN' || !account.update(data.tokens, data.fetchedAt)) throw new Error('Stale market');
      state.watch = state.watch.filter(a => !account.excluded(a) && (account.holding(a) || data.tokens.some(t => t.address === a)));
      for (const token of data.tokens) {
        if (state.watch.length < 4 && !account.excluded(token.address) && !state.watch.includes(token.address)) {
          state.watch.push(token.address);
          emit('scout', 'watch', token.address, 'Watching ' + token.symbol + ' for a closed M1/M5 entry', token);
        }
      }
      if (!feeds.wallet && !data.tokens.length) emit('scout', 'no-eligible-tokens', 'SCAN', 'No eligible tokens; strict filters unchanged. No fallback buys.', {});
      const missing = Object.keys(account.snapshot().positions).filter(a => !data.tokens.some(t => t.address === a));
      if (missing.length) {
        const address = missing[state.holdingCursor++ % missing.length];
        try {
          const quote = await feeds.quote(address);
          if (!account.update([{ address, price: quote.price, marketCap: quote.marketCap }], quote.fetchedAt)) throw new Error('Stale quote');
          emit('scout', 'holding-quote', address, 'Refreshed holding outside the entry universe', quote);
        } catch { emit('feed', 'holding-unavailable', address, 'Holding quote unavailable; no invented exit.', {}); }
      }
      if (feeds.wallet && walletReady && state.wallet) {
        // A later observed sell cancels an unprocessed buy: never buy an already flipped round trip.
        const queue = state.wallet.queue.filter(a => now() - a.timestamp <= 120000);
        const latest = queue.filter((a, i) => !(a.side === 'buy' && queue.slice(i + 1).some(b => b.address === a.address && b.side === 'sell')));
        const action = latest.find(a => a.side === 'sell' && account.holding(a.address)) ||
          latest.find(a => a.side === 'buy');
        if (action) {
          const quote = await feeds.quote(action.address);
          if (!account.update([{ address: action.address, price: quote.price, marketCap: quote.marketCap }], quote.fetchedAt)) throw new Error('Stale wallet quote');
          // Wallet-only entries: current quote and cash cap, no universe/safety filters.
          const executed = action.side === 'sell' ? account.followSell(action.address) : account.enter(action.address, {
            qualified: true, resolution: 'wallet', closedAt: action.timestamp, expiresAt: action.timestamp + 120000, signature: action.signature
          });
          emit('executor', 'wallet-action', action.address, executed ? 'Wallet signal simulated at current quote, not source execution price.' : 'Wallet action skipped by risk/eligibility or protective exit.', { ...action, wallet: FOLLOW_WALLET, executed });
          state.wallet.queue = latest.filter(a => a.signature !== action.signature);
        } else state.wallet.queue = latest.filter(a => a.side === 'sell' && account.holding(a.address));
      } else if (!feeds.wallet && !missing.length) {
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
      state.status = !walletReady ? 'Helius unavailable — wallet entries paused' : !feeds.wallet && account.snapshot().daily.paused ? 'Daily loss limit — new buys paused until next UTC−4 day' : (feeds.wallet ? 'Helius wallet-following paper trading active' : 'Scheduled paper trading active');
    } catch {
      state.status = 'GMGN unavailable — no fills without fresh data';
      emit('feed', 'paused', 'FEED', 'No fresh market snapshot. Positions retained; no synthetic fallback.', {});
    }
    state.account = account.exportState();
    state.snapshot = account.snapshot();
    emit('logger', 'account', 'ACCOUNT', 'Virtual equity $' + state.snapshot.equity.toFixed(2) + ' | P/L $' + state.snapshot.pnl.toFixed(2) + ' | cash $' + state.snapshot.cash.toFixed(2), state.snapshot);
    // Seed once from the available current-account window; never infer trimmed totals.
    let resetIndex = -1;
    state.events.forEach((e, i) => { if (e.meta?.kind === 'account-reset') resetIndex = i; });
    const seed = resetIndex >= 0 ? state.events.slice(resetIndex + 1) : state.events;
    state.activity = addActivity(reset ? undefined : state.activity || addActivity(undefined, seed, now()), pending, now());
    state.tokenNames ||= {};
    for (const e of pending) if (typeof e.meta?.symbol === 'string' && e.meta.symbol !== e.meta.address) state.tokenNames[e.meta.address] = e.meta.symbol;
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
      status: state.status, policyEpoch: state.policyEpoch, cash: state.snapshot.cash, events: pending.length, positions: Object.keys(state.account.positions).length, tradedMints: Object.keys(state.account.traded || {}).length,
      blockedMints: Object.keys(state.account.excluded).length, daily: state.snapshot.daily, walletLastRead: state.wallet?.lastRead, walletObserved: state.wallet?.observed, walletScanned: state.wallet?.scanned, archivedEvents: archiveEvents.length, seq: state.seq }));
    return { lastAttempt: state.lastAttempt, lastSuccess: state.lastSuccess, status: state.status, seq: state.seq };
  } finally { await db.eval(RELEASE, [LOCK_KEY], [owner]); }
}
