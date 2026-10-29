import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { candleSignal } from '../api/_lib/candles';

function setup() {
  const context: any = {}; runInNewContext(readFileSync('public/strategy.js', 'utf8'), context);
  let time = 1000000; const events: any[] = [];
  const a = context.HermesRules.create((...args: any[]) => events.push(args), () => time);
  const quote = (price: number) => { time += 1000; a.update([{ address: 'token', price }], time); };
  const signal = () => ({ qualified: true, resolution: '1m', closedAt: time - 1000, expiresAt: time + 60000 });
  quote(100); a.enter('token', signal());
  return { a, quote, signal, events, now: () => time };
}

test('35% stop closes all, accounts costs, and excludes the token permanently for the session', () => {
  const { a, quote, signal, events } = setup();
  const p = a.snapshot().positions.token;
  quote(p.entry * 0.6501); assert.ok(a.holding('token'));
  quote(p.entry * 0.65);
  assert.equal(a.holding('token'), false); assert.equal(a.excluded('token'), true);
  assert.equal(a.enter('token', signal()), false);
  assert.ok(events.some((e) => e[1] === 'stop-loss'));
  const proceeds = p.qty * p.entry * 0.65 * 0.9995 * 0.999;
  assert.ok(Math.abs(a.snapshot().cash - (9499.5 + proceeds)) < 1e-8);
});

test('take-profit leaves 10%, moonbag has no stop, 5x and 10x sell 90% of remainder only once', () => {
  const { a, quote, events } = setup();
  const p = a.snapshot().positions.token;
  quote(p.entry * 1.5);
  assert.ok(Math.abs(a.snapshot().positions.token.qty / p.qty - 0.1) < 1e-10);
  quote(p.entry * 0.1); assert.ok(a.holding('token')); assert.equal(a.excluded('token'), false);
  quote(p.entry * 5);
  assert.ok(Math.abs(a.snapshot().positions.token.qty / p.qty - 0.01) < 1e-10);
  quote(p.entry * 5); quote(p.entry * 10); quote(p.entry * 12);
  assert.ok(Math.abs(a.snapshot().positions.token.qty / p.qty - 0.001) < 1e-10);
  assert.equal(events.filter((e) => e[1] === 'moonbag-5x').length, 1);
  assert.equal(events.filter((e) => e[1] === 'moonbag-10x').length, 1);
  const state = a.snapshot();
  assert.ok(Math.abs(state.equity - (state.cash + state.positions.token.qty * p.entry * 12)) < 1e-8);
});

test('gap to 10x performs all stages sequentially; missing quotes do not invent exits', () => {
  const { a, quote, now } = setup(); const p = a.snapshot().positions.token;
  a.update([], now() + 1000); assert.ok(a.holding('token'));
  quote(p.entry * 10);
  assert.ok(Math.abs(a.snapshot().positions.token.qty / p.qty - 0.001) < 1e-10);
});

test('entries reject unfinished/expired/unqualified signals, and a replacement can enter', () => {
  const { a, quote, now } = setup(); const p = a.snapshot().positions.token;
  quote(p.entry * 0.5); a.update([{ address: 'replacement', price: 10 }], now());
  const enter = (s: any) => a.enter('replacement', s);
  assert.equal(enter({ qualified: false }), false);
  assert.equal(enter({ qualified: true, resolution: '1m', closedAt: now() + 1, expiresAt: now() + 60000 }), false);
  assert.equal(enter({ qualified: true, resolution: '1m', closedAt: now() - 10000, expiresAt: now() - 1 }), false);
  assert.equal(enter({ qualified: true, resolution: '5m', closedAt: now() - 1000, expiresAt: now() + 1000 }), true);
});

function candles(seconds = 60) {
  const rows: any[] = [];
  for (let i = 0; i < 17; i++) rows.push({ time: (1000 + i) * seconds, open: 110, close: 111, high: 112, low: 109, volume: 10 });
  rows.push({ time: 1017 * seconds, open: 110, close: 108, high: 111, low: 107, volume: 10 },
    { time: 1018 * seconds, open: 108, close: 106, high: 109, low: 105, volume: 10 },
    { time: 1019 * seconds, open: 106, close: 104, high: 107, low: 103, volume: 10 },
    { time: 1020 * seconds, open: 103, close: 107, high: 108, low: 102, volume: 20 });
  return rows;
}

test('M1 and M5 entries need closed engulfing, declining candles, high volume and contiguous history', () => {
  for (const [resolution, seconds] of [['1m', 60], ['5m', 300]] as const) {
    const rows = candles(seconds), now = (1021 * seconds + 1) * 1000;
    const body = () => ({ code: 0, data: { list: rows } });
    assert.equal(candleSignal(body(), resolution, now).qualified, true);
    assert.equal(candleSignal(body(), resolution, (1020 * seconds + 30) * 1000).qualified, false);
    rows[20].volume = 10; assert.equal(candleSignal(body(), resolution, now).qualified, false);
    rows[20].volume = 20; rows[20].close = 105; assert.equal(candleSignal(body(), resolution, now).qualified, false);
    rows[20].close = 107; rows[18].close = 109; assert.equal(candleSignal(body(), resolution, now).qualified, false);
    rows[18].close = 106; rows[10].time += seconds; assert.equal(candleSignal(body(), resolution, now).qualified, false);
  }
});
