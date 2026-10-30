import assert from 'node:assert/strict';
import test from 'node:test';
import { create } from '../public/strategy';
const policy = { unfilteredEntries: true, repeatBuys: true, noDailyPause: true };
test('repeat wallet buys aggregate quantity and cost, deduplicate signatures, and stop/re-enter without borrowing', () => {
  let time = 1000000; let a = create(() => {}, () => time, undefined, policy);
  const quote = (p: number, cap = 10000) => { time++; a.update([{ address: 'mint', price: p, marketCap: cap }], time); };
  const buy = (signature: string) => a.enter('mint', { qualified: true, resolution: 'wallet', signature, closedAt: time, expiresAt: time + 120000 });
  quote(100); assert.ok(buy('first')); const first = a.snapshot().positions.mint;
  assert.ok(buy('second')); assert.equal(a.snapshot().cash, 9000);
  assert.equal(a.snapshot().positions.mint.cost, 1000);
  assert.equal(a.snapshot().positions.mint.qty, first.qty * 2);
  assert.equal(buy('second'), false);
  quote(50); assert.equal(a.holding('mint'), false);
  a = create(() => {}, () => time, a.exportState(), policy); quote(100);
  assert.ok(buy('after-stop'));
  // ENTRY cap filter removed, but protective cap exit still runs on next fresh quote.
  quote(100, 1000); assert.equal(a.holding('mint'), false);
  assert.ok(buy('low-cap-entry')); quote(100, 1000); assert.equal(a.holding('mint'), false);
  const saved = a.exportState(); saved.cash = 499;
  a = create(() => {}, () => time, saved, policy); assert.equal(buy('no-borrowing'), false);
});
test('daily loss exceeding 5000 does not pause fresh-policy entries; $500 budget still enforced', () => {
  let time = 1000000; let a = create(() => {}, () => time, undefined, policy);
  const saved = a.exportState(); saved.cash = 1000; saved.daily!.openingEquity = 10000;
  a = create(() => {}, () => time, saved, policy);
  a.update([{ address: 'new', price: 1 }], time);
  assert.ok(a.enter('new', { qualified: true, resolution: 'wallet', signature: 'unique', closedAt: time, expiresAt: time + 120000 }));
  assert.equal(a.snapshot().cash, 500); assert.equal(a.snapshot().daily.enabled, false);
  assert.equal(a.snapshot().daily.paused, false);
});
