import assert from 'node:assert/strict';
import test from 'node:test';
import { create } from '../public/strategy';
test('40% of net profit is reserved, preserving total equity and moonbag; losses never debit reserve', () => {
  let time = 1000000; const events: any[] = [];
  let a = create((...e) => events.push(e), () => time);
  a.update([{ address: 'mint', price: 100 }], time);
  a.enter('mint', { qualified: true, resolution: 'wallet', closedAt: time, expiresAt: time + 120000, signature: 'buy' });
  time++; a.update([{ address: 'mint', price: 110 }], time); a.followSell('mint');
  const sell = events.find(e => e[1] === 'wallet-profit-sell')[4];
  const s = a.snapshot(); assert.ok(Math.abs(s.reserve - sell.realizedPnl * .4) < 1e-9);
  assert.ok(Math.abs(s.equity - (s.cash + s.reserve + s.positions.mint.qty * 110)) < 1e-9);
  const reserved = s.reserve; a = create(() => {}, () => time, a.exportState());
  assert.equal(a.snapshot().reserve, reserved);
  time++; a.update([{ address: 'mint', price: 80 }], time); a.followSell('mint');
  assert.equal(a.snapshot().reserve, reserved);
});
test('legacy balances are not swept; reserve cannot fund new buys', () => {
  const a = create(() => {}, () => 1000000); const saved = a.exportState();
  delete saved.reserve; saved.cash = 499; saved.realized = 1000;
  const b = create(() => {}, () => 1000000, saved);
  assert.equal(b.snapshot().cash, 499); assert.equal(b.snapshot().reserve, 0);
  saved.reserve = 1000;
  const c = create(() => {}, () => 1000000, saved);
  c.update([{ address: 'new', price: 1 }], 1000000);
  assert.equal(c.enter('new', { qualified: true, resolution: 'wallet', signature: 'x', closedAt: 1000000, expiresAt: 1100000 }), false);
});
