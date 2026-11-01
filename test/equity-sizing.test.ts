import assert from 'node:assert/strict';
import test from 'node:test';
import { create } from '../public/strategy';
test('buy budgets switch at trading equity 5000 and exclude protected reserve', () => {
  for (const [cash, reserve, budget] of [[4999.99, 10000, 100], [5000, 10000, 500], [5000.01, 0, 500]]) {
    const saved = create(() => {}, () => 1000000).exportState(); saved.cash = cash; saved.reserve = reserve;
    const a = create(() => {}, () => 1000000, saved, { noDailyPause: true, repeatBuys: true });
    a.update([{ address: 'new', price: 1 }], 1000000);
    assert.equal((a.snapshot() as any).maxOrderCost, budget);
    assert.ok(a.enter('new', { qualified: true, resolution: 'wallet', signature: 'buy', closedAt: 1000000, expiresAt: 1100000 }));
    assert.equal(a.snapshot().cash, cash - budget); assert.equal(a.snapshot().positions.new.cost, budget);
  }
});
test('holdings count toward trading equity; insufficient cash still skips', () => {
  const saved = create(() => {}, () => 1000000).exportState(); saved.cash = 100;
  saved.positions = { held: { entry: 1, qty: 5000, originalQty: 5000, cost: 5000, moonbag: false, sold5x: false, sold10x: false } };
  saved.quotes = { held: { price: 1, time: 1000000 } };
  const a = create(() => {}, () => 1000000, saved);
  a.update([{ address: 'new', price: 1 }], 1000000);
  assert.equal((a.snapshot() as any).maxOrderCost, 500);
  assert.equal(a.enter('new', { qualified: true, resolution: 'wallet', closedAt: 1000000, expiresAt: 1100000 }), false);
});
