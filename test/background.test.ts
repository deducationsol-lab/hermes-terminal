import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { create } from '../public/strategy';
import { authorized } from '../api/background-run';
import { runBackground, STATE_KEY, LOCK_KEY, COMMIT, historyKey, riskDay, type BackgroundStore, type BackgroundState } from '../api/_lib/background';

class Store implements BackgroundStore {
  values = new Map<string, any>();
  failCommit = false;
  async get<T>(key: string): Promise<T | null> { return structuredClone(this.values.get(key) || null); }
  async set(key: string, value: string) { if (this.values.has(key)) return null; this.values.set(key, value); return 'OK'; }
  async eval(script: string, keys: string[], args: string[]) {
    if (this.failCommit && script === COMMIT) throw new Error('Store down');
    if (this.values.get(keys[0]) !== args[0]) return 0;
    if (script === COMMIT) {
      for (const group of JSON.parse(args[2])) {
        const archive: Record<string, any> = this.values.get(keys[group.key - 1]) || {};
        for (const event of group.events) archive[event.seq] = JSON.parse(event.json);
        this.values.set(keys[group.key - 1], archive);
      }
      this.values.set(keys[1], JSON.parse(args[1]));
    }
    this.values.delete(keys[0]); return 1;
  }
}
const mint = 'So11111111111111111111111111111111111111112';
function fixture() {
  let time = 1000000, price = 100, available = true;
  const db = new Store();
  const feeds = {
    market: async (): Promise<any> => {
      if (!available) throw new Error('Offline');
      return { chain: 'sol', source: 'GMGN', fetchedAt: time, tokens: [{ address: mint, symbol: 'SIM', price, ageMinutes: 1 }] };
    },
    quote: async () => ({ price, marketCap: 10000, fetchedAt: time, quoteSymbol: 'WSOL' }),
    signal: async () => ({ signals: [{ qualified: true, resolution: '1m', closedAt: time - 1000, expiresAt: time + 59000 }] })
  };
  return { db, feeds, now: () => time, advance: () => { time += 60000; }, price: (p: number) => { price = p; }, offline: () => { available = false; } };
}

test('server cycles persist buys and stop blacklist with no browser; duplicate delivery cannot trade twice', async () => {
  const f = fixture();
  await runBackground(f.db, f.feeds, f.now);
  const first = (await f.db.get<BackgroundState>(STATE_KEY))!;
  assert.equal(first.account.cash, 9500); assert.ok(first.account.positions[mint]);
  assert.deepEqual(await runBackground(f.db, f.feeds, f.now), { skipped: 'duplicate' });
  assert.equal((await f.db.get<BackgroundState>(STATE_KEY))!.seq, first.seq);
  f.advance(); f.price(50);
  await runBackground(f.db, f.feeds, f.now);
  const second = (await f.db.get<BackgroundState>(STATE_KEY))!;
  assert.equal(Object.keys(second.account.positions).length, 0);
  assert.equal(second.account.excluded[mint], true);
  assert.equal(second.events.filter(e => e.meta.kind === 'stop-loss').length, 1);
  f.advance(); f.price(100); await runBackground(f.db, f.feeds, f.now);
  assert.equal((await f.db.get<BackgroundState>(STATE_KEY))!.events.filter(e => e.meta.kind === 'simulated-buy').length, 1);
});

test('restored moonbag milestones and used signals never repeat; export is detached', () => {
  let time = 1000000; const events: string[] = [];
  let a = create((_, kind) => events.push(kind), () => time);
  a.update([{ address: mint, price: 100 }], time);
  a.enter(mint, { qualified: true, resolution: '1m', closedAt: time, expiresAt: time + 60000 });
  const original = a.exportState(); original.cash = 0; assert.equal(a.snapshot().cash, 9500);
  time++; a.update([{ address: mint, price: 1001 }], time);
  const qty = a.snapshot().positions[mint].qty;
  a = create((_, kind) => events.push(kind), () => time, a.exportState());
  time++; a.update([{ address: mint, price: 1002 }], time);
  assert.equal(a.snapshot().positions[mint].qty, qty);
  assert.equal(events.filter(k => k === 'moonbag-10x').length, 1);
  assert.ok(Object.keys(a.exportState().used).length);
});

test('overlap and expired owners cannot commit; failed commit leaves previous account intact', async () => {
  const f = fixture(); f.db.values.set(LOCK_KEY, 'another-worker');
  assert.deepEqual(await runBackground(f.db, f.feeds, f.now), { skipped: 'overlap' });
  assert.equal(await f.db.get(STATE_KEY), null); f.db.values.delete(LOCK_KEY);
  await runBackground(f.db, f.feeds, f.now);
  const original = await f.db.get(STATE_KEY); f.advance(); f.price(50);
  f.db.failCommit = true;
  await assert.rejects(runBackground(f.db, f.feeds, f.now), /Store down/);
  assert.deepEqual(await f.db.get(STATE_KEY), original);
  f.db.failCommit = false;
  const market = f.feeds.market;
  f.feeds.market = async () => { f.db.values.set(LOCK_KEY, 'new-owner'); return market(); };
  await assert.rejects(runBackground(f.db, f.feeds, f.now), /Lease lost/);
  assert.deepEqual(await f.db.get(STATE_KEY), original);
  assert.equal(f.db.values.get(LOCK_KEY), 'new-owner');
});

test('feed outage records a failed attempt but preserves positions and last success; history bounded', async () => {
  const f = fixture(); await runBackground(f.db, f.feeds, f.now);
  const saved = (await f.db.get<BackgroundState>(STATE_KEY))!;
  saved.events = Array.from({ length: 500 }, (_, seq) => ({ seq })); saved.seq = 500;
  f.db.values.set(STATE_KEY, saved); f.advance(); f.offline();
  await runBackground(f.db, f.feeds, f.now);
  const next = (await f.db.get<BackgroundState>(STATE_KEY))!;
  assert.deepEqual(next.account, saved.account);
  assert.equal(next.lastSuccess, saved.lastSuccess); assert.ok(next.lastAttempt > saved.lastAttempt);
  assert.equal(next.events.length, 500); assert.match(next.status, /unavailable/);
});

test('cron authorization fails closed and compares exact bearer token', () => {
  assert.equal(authorized(undefined, undefined), false);
  assert.equal(authorized('Bearer demo', undefined), false);
  assert.equal(authorized('Bearer wrong', 'demo'), false);
  assert.equal(authorized('Bearer demo', 'demo'), true);
});

test('background viewer only reads status, deduplicates history and does not stop server on pause/close', async () => {
  const context: any = { AbortController };
  runInNewContext(readFileSync('public/background.js', 'utf8'), context);
  const timers = new Map<number, { fn: () => void; ms: number }>(); let id = 0;
  const paths: string[] = [], events: any[] = [];
  const viewer = context.HermesBackground.create({ emit: (e: any) => events.push(e), status: () => {},
    setTimeout: (fn: () => void, ms: number) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: (i: number) => timers.delete(i),
    fetch: async (path: string) => { paths.push(path); return { ok: true, json: async () => ({ lastAttempt: Date.now(), lastSuccess: Date.now(), status: 'Active', events: [{ seq: 1 }], snapshot: { staleMarks: [] } }) }; }
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  viewer.start(); await flush(); viewer.pause(true);
  const next = [...timers.entries()].find(([, t]) => t.ms === 15000)!; timers.delete(next[0]); next[1].fn(); await flush();
  assert.equal(events.length, 1); assert.deepEqual(paths, ['/api/background', '/api/background']);
  viewer.stop(); assert.equal(timers.size, 0);
});

test('legacy prior buys migrate even without a holding or blacklist; new signals cannot re-enter', () => {
  let time = 1000000;
  const a = create(() => {}, () => time);
  a.update([{ address: mint, price: 100 }], time);
  const signal = { qualified: true, resolution: '1m', closedAt: time, expiresAt: time + 60000 };
  assert.equal(a.enter(mint, signal), true);
  const saved = a.exportState();
  delete saved.traded; saved.positions = {}; saved.excluded = {};
  const b = create(() => {}, () => time, saved);
  assert.equal(b.excluded(mint), true);
  assert.equal(b.exportState().traded![mint], true);
  time++;
  b.update([{ address: mint, price: 200 }], time);
  assert.equal(b.enter(mint, { ...signal, resolution: '5m', closedAt: time }), false);
  assert.equal(b.snapshot().cash, saved.cash);
  const failed = 'never-bought';
  b.update([{ address: failed, price: 1 }], time);
  assert.equal(b.enter(failed, { ...signal, qualified: false }), false);
  assert.equal(b.excluded(failed), false);
});

test('stop-loss removes old mint and buys a different eligible token after restore, never rebuys on recovery', async () => {
  const f = fixture();
  const replacement = 'J9ZeznJEReSFmUzwnvQspTvJCtkNb28YiiucjxU9pump';
  const original = f.feeds.market;
  let replace = false;
  f.feeds.market = async () => {
    const market = await original();
    if (replace) market.tokens.push({ ...market.tokens[0], address: replacement });
    return market;
  };
  await runBackground(f.db, f.feeds, f.now);
  f.advance(); f.price(20); replace = true;
  await runBackground(f.db, f.feeds, f.now);
  let saved = (await f.db.get<BackgroundState>(STATE_KEY))!;
  assert.ok(!saved.watch.includes(mint));
  assert.ok(saved.watch.includes(replacement));
  assert.ok(saved.account.positions[replacement]);
  assert.equal(saved.account.traded![mint], true);
  f.advance(); f.price(100);
  await runBackground(f.db, f.feeds, f.now);
  saved = (await f.db.get<BackgroundState>(STATE_KEY))!;
  assert.equal(saved.events.filter(e => e.meta.kind === 'simulated-buy' && e.meta.address === mint).length, 1);
  assert.ok(!saved.account.positions[mint]);
});


test('dated history is committed with state, backfilled once, survives recent-view trimming and failed commit', async () => {
  const f = fixture(); await runBackground(f.db, f.feeds, f.now);
  const saved = (await f.db.get<BackgroundState>(STATE_KEY))!;
  const key = historyKey(riskDay(f.now()));
  assert.equal(Object.keys((await f.db.get<any>(key))!).length, saved.seq);
  const before = await f.db.get(key); f.advance(); f.db.failCommit = true;
  await assert.rejects(runBackground(f.db, f.feeds, f.now));
  assert.deepEqual(await f.db.get(key), before);
  f.db.failCommit = false;
  const legacy = { ...saved, historyArchived: false }; f.db.values.set(STATE_KEY, legacy);
  await runBackground(f.db, f.feeds, f.now);
  const next = (await f.db.get<BackgroundState>(STATE_KEY))!;
  assert.equal(Object.keys((await f.db.get<any>(key))!).length, next.seq);
  assert.ok(next.historyArchived);
  next.events = []; f.db.values.set(STATE_KEY, next); f.advance();
  await runBackground(f.db, f.feeds, f.now);
  assert.ok(Object.keys((await f.db.get<any>(key))!).length > saved.seq);
});


test('archive groups recovered logs by UTC-4 date, retaining prior day after rollover', async () => {
  const f = fixture(); await runBackground(f.db, f.feeds, f.now);
  const saved = (await f.db.get<BackgroundState>(STATE_KEY))!;
  const prior = f.now() - 86400000;
  saved.events.unshift({ seq: -1, ts: prior, message: 'Prior day retained' });
  saved.historyArchived = false; f.db.values.set(STATE_KEY, saved); f.advance();
  await runBackground(f.db, f.feeds, f.now);
  const old = await f.db.get<any>(historyKey(riskDay(prior)));
  assert.equal(old['-1'].message, 'Prior day retained');
  assert.ok(await f.db.get(historyKey(riskDay(f.now()))));
});

test('persistent minimum spacing allows next half-minute, blocks earlier and duplicate worker checks', async () => {
  const f = fixture(); let time = f.now();
  // Empty market isolates spacing from fixture quote timestamps.
  f.feeds.market = async (): Promise<any> => ({ chain: 'sol', source: 'GMGN', fetchedAt: time, tokens: [] });
  await runBackground(f.db, f.feeds, () => time);
  time += 29999; assert.deepEqual(await runBackground(f.db, f.feeds, () => time), { skipped: 'duplicate' });
  time++; assert.ok(!('skipped' in await runBackground(f.db, f.feeds, () => time)));
  assert.equal((await f.db.get<BackgroundState>(STATE_KEY))!.lastAttempt, time);
  assert.deepEqual(await runBackground(f.db, f.feeds, () => time), { skipped: 'duplicate' });
});
