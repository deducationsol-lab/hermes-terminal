import assert from 'node:assert/strict';
import test from 'node:test';
import { create } from '../public/strategy';
import { historyQuery } from '../api/history';

// A legacy account with a large existing moonbag lets unrealized losses exercise
// the limit without changing the existing $500 per-buy allocation rule.
function setup() {
  let time = Date.parse('2026-10-30T12:00:00Z');
  const empty = create(() => {}, () => time).exportState(); delete empty.daily;
  const saved = { ...empty, cash: 3000, positions: { old: { entry: 1, qty: 7000, originalQty: 7000, cost: 7000, moonbag: true, sold5x: false, sold10x: false } },
    quotes: { old: { price: 1, time } } };
  const events: any[] = [];
  let account = create((...args) => events.push(args), () => time, saved);
  return { get account() { return account; }, events, setTime(t: number) { time = t; },
    quote(price: number) { time++; account.update([{ address: 'old', price }], time); },
    restore() { account = create((...args) => events.push(args), () => time, account.exportState()); },
    buy(address: string) { account.update([{ address, price: 1 }], time); return account.enter(address, { qualified: true, resolution: '1m', closedAt: time, expiresAt: time + 60000 }); } };
}

test('exact $5000 equity loss latches entry pause through recovery/restart; exits continue', () => {
  const f = setup();
  f.quote(2001 / 7000); assert.equal(f.account.snapshot().daily.paused, false);
  f.quote(2000 / 7000); assert.equal(f.account.snapshot().daily.paused, true);
  assert.equal(f.buy('fresh'), false);
  f.quote(1); f.restore(); assert.equal(f.account.snapshot().daily.paused, true);
  assert.equal(f.buy('fresh'), false);
  f.quote(5); assert.equal(f.events.filter(e => e[1] === 'moonbag-5x').length, 1);
  assert.equal(f.events.filter(e => e[1] === 'daily-loss-limit').length, 1);
});

test('rollover at 04:00 UTC preserves cash/positions/registry and resumes using remaining equity', () => {
  const f = setup(); f.quote(2000 / 7000);
  const before = f.account.exportState();
  f.setTime(Date.parse('2026-10-31T03:59:59.999Z')); f.restore();
  assert.equal(f.account.snapshot().daily.day, '2026-10-30');
  assert.equal(f.account.snapshot().daily.paused, true);
  f.setTime(Date.parse('2026-10-31T04:00:00Z')); f.restore();
  const after = f.account.exportState();
  assert.equal(after.daily!.day, '2026-10-31'); assert.equal(after.daily!.paused, false);
  assert.equal(after.daily!.openingEquity, 5000); assert.equal(after.daily!.lossLimit, 5000);
  assert.equal(after.cash, before.cash); assert.deepEqual(after.positions, before.positions);
  assert.deepEqual(after.traded, before.traded);
  f.quote(2000 / 7000); assert.equal(f.buy('new-mint'), true);
  assert.equal(f.account.snapshot().cash, 2500);
});

test('history query validates calendar date and bounded integer offset', () => {
  assert.deepEqual(historyQuery('/api/history?day=2026-10-30&offset=100'), { day: '2026-10-30', offset: 100 });
  for (const query of ['day=2026-02-30', 'day=../../x', 'offset=-1', 'offset=1.5', 'offset=Infinity']) {
    assert.throws(() => historyQuery('/api/history?' + query));
  }
});
