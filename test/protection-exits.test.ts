import assert from 'node:assert/strict';
import test from 'node:test';
import { create } from '../public/strategy';
import { normalizeQuote } from '../api/quote';
function setup() {
  let time = 1000000;
  const events: any[] = [];
  let a = create((...e) => events.push(e), () => time);
  const update = (price: number, marketCap: number | null = 10000) => { time++; a.update([{ address: 'mint', price, marketCap }], time); };
  update(100); a.enter('mint', { qualified: true, resolution: '1m', closedAt: time, expiresAt: time + 60000 });
  return { get a() { return a; }, events, update, restore() { a = create((...e) => events.push(e), () => time, a.exportState()); } };
}
test('market cap strictly below 5000 exits normal and moonbag positions, blocks re-entry', () => {
  for (const moonbag of [false, true]) {
    const f = setup(); if (moonbag) f.update(160);
    f.update(moonbag ? 160 : 100, 5000); assert.ok(f.a.holding('mint'));
    f.update(moonbag ? 160 : 100, 4999.99); assert.ok(!f.a.holding('mint'));
    assert.ok(f.a.excluded('mint')); assert.equal(f.events.filter(e => e[1] === 'market-cap-exit').length, 1);
    f.restore(); f.update(100, 10000); assert.ok(f.a.excluded('mint'));
  }
});
test('fixed moonbag anchor uses actual creation quote, persists and is not a trailing high', () => {
  const f = setup(); f.update(200); assert.equal(f.a.snapshot().positions.mint.moonbagPrice, 200);
  f.update(1000); f.restore(); f.update(100.01); assert.ok(f.a.holding('mint'));
  f.update(100); assert.ok(!f.a.holding('mint'));
  assert.equal(f.events.filter(e => e[1] === 'moonbag-stop-50').length, 1);
});
test('invalid/stale caps do not invent exits; unknown cap does not overwrite a fresh value with an older quote', () => {
  const f = setup(); f.update(100, null); assert.ok(f.a.holding('mint'));
  f.a.update([{ address: 'mint', price: 100, marketCap: 0 }], 1); assert.ok(f.a.holding('mint'));
  f.update(100, 0); assert.ok(!f.a.holding('mint'));
});
test('fresh low cap rejects a buy; unknown provider cap is null rather than zero', () => {
  const a = create(() => {}, () => 1000000);
  a.update([{ address: 'new', price: 1, marketCap: 4999 }], 1000000);
  assert.equal(a.enter('new', { qualified: true, resolution: '1m', closedAt: 999999, expiresAt: 1000001 }), false);
  for (const cap of [null, '', false, -1, 'NaN']) {
    assert.equal(normalizeQuote({ code: 0, data: { price: { price: 1 }, market_cap: cap } }, 'mint', 1).marketCap, null);
  }
  assert.equal(normalizeQuote({ code: 0, data: { price: { price: 1, market_cap: '4999' } } }, 'mint', 1).marketCap, 4999);
});
