import assert from 'node:assert/strict';
import test from 'node:test';
import { addActivity, dashboard } from '../api/_lib/dashboard';
import { normalizeQuote } from '../api/quote';
const buy = { ts: 100, meta: { agent: 'executor', kind: 'simulated-buy', address: 'mint', quantity: 10, fill: 49.95, fee: .5, totalCost: 500 } };
const sell = { ts: 200, meta: { agent: 'executor', kind: 'wallet-profit-sell', address: 'mint', quantity: 9, remaining: 1, fill: 60, fee: .54, realizedPnl: 89.46 } };
test('activity counts actual fills, not wallet observations; persists beyond recent logs and does not mutate input', () => {
  const a = addActivity(undefined, [buy, { meta: { kind: 'wallet-action', executed: true } }], 100);
  const b = addActivity(a, [sell], 200);
  assert.equal(a.sells, 0); assert.equal(b.buys, 1); assert.equal(b.sells, 1);
  assert.equal(b.tokens.mint.bought, 10); assert.equal(b.tokens.mint.sold, 9);
  assert.equal(b.buyCost, 500); assert.equal(b.sellProceeds, 539.46); assert.equal(b.fees, 1.04);
  assert.match(b.coverage, /missing/);
});
test('summary uses remaining holdings/marks and explicit source observation counts without guessing names', () => {
  const state: any = { activity: addActivity(undefined, [buy, sell], 100), tokenNames: { mint: '<script>untrusted</script>' },
    account: { positions: { mint: { qty: 1, originalQty: 10, cost: 50, entry: 49.95, moonbag: true } }, quotes: { mint: { price: 60, time: 1 } } },
    snapshot: { pnl: 100, realized: 90 }, wallet: { scanned: 50, observed: 20 }, events: [buy, sell], lastAttempt: 200 };
  const d = dashboard(state);
  assert.equal(d.holdings[0].quantity, 1); assert.equal(d.holdings[0].accumulatedQuantity, 10);
  assert.equal(d.holdings[0].value, 60); assert.equal(d.holdings[0].unrealized, 10);
  assert.equal(d.holdings[0].stale, true); assert.equal(d.unrealized, 10);
  assert.equal(d.source.swaps, 20); assert.equal(d.fills.length, 2);
  delete state.tokenNames.mint; assert.equal(dashboard(state).holdings[0].symbol, null);
});
test('provider token symbol remains untrusted display data and is bounded', () => {
  const q = normalizeQuote({ code: 0, data: { price: { price: 1 }, symbol: 'A'.repeat(100) } }, 'mint', 100);
  assert.equal(q.tokenSymbol?.length, 32);
});
