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
  assert.ok(Math.abs(a.snapshot().cash - (9500 + proceeds)) < 1e-8);
});

test('take-profit leaves 10%, moonbag has no stop, 5x and 10x sell 90% of remainder only once', () => {
  const { a, quote, events } = setup();
  const p = a.snapshot().positions.token;
  quote(p.entry * 1.5);
  assert.ok(Math.abs(a.snapshot().positions.token.qty / p.qty - 0.1) < 1e-10);
  quote(p.entry * 0.1); assert.ok(a.holding('token')); assert.equal(a.excluded('token'), true); // No re-entry, but moonbag sells continue.
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

test('M1 and M5 engulfing uses only the last two closed candles, independently of trend and volume', () => {
  for (const [resolution, seconds] of [['1m', 60], ['5m', 300]] as const) {
    const rows = candles(seconds).slice(-2), now = 1021 * seconds * 1000;
    rows[1].volume = 0;
    const body = () => ({ code: 0, data: { list: rows } });
    const signal = candleSignal(body(), resolution, now);
    assert.equal(signal.qualified, true);
    assert.equal(signal.pattern, 'bullish-engulfing');
    assert.equal(signal.closedAt, now);
    assert.equal(signal.expiresAt, now + seconds * 1000);
    assert.equal(candleSignal(body(), resolution, now - 1).qualified, false);
    assert.equal(candleSignal(body(), resolution, now + seconds * 1000 - 1).qualified, true);
    assert.equal(candleSignal(body(), resolution, now + seconds * 1000).qualified, false);
    const epoch = Math.floor(1700000000 / seconds) * seconds;
    const modern = rows.map((row) => ({ ...row, time: row.time + epoch }));
    assert.equal(candleSignal({ code: 0, data: { list: modern.map((row) => ({ ...row, time: row.time * 1000 })) } }, resolution, now + epoch * 1000).qualified, true);
    rows[1].close = 105; assert.equal(candleSignal(body(), resolution, now).qualified, false);
    rows[1].close = 107; rows[0].time -= seconds;
    assert.equal(candleSignal(body(), resolution, now).qualified, false);
  }
});

test('engulfing requires a bearish preceding body, strict engulfment and exactly one valid bar at each time', () => {
  const now = 1021 * 60 * 1000;
  for (const change of [
    (rows: any[]) => { rows[0].close = rows[0].open; },
    (rows: any[]) => { rows[0].open = 103; rows[0].close = 104; },
    (rows: any[]) => { rows[1].open = 104; rows[1].close = 106; },
    (rows: any[]) => { rows[0].high = 1; },
    (rows: any[]) => { rows[1].low = 108; },
    (rows: any[]) => { rows.push({ ...rows[0] }); },
    (rows: any[]) => { rows.push({ ...rows[1] }); }
  ]) {
    const rows = candles().slice(-2); change(rows);
    assert.equal(candleSignal({ code: 0, data: { list: rows } }, '1m', now).qualified, false);
  }
});

test('old gaps do not gate patterns, but a newer closed non-pattern cannot reuse an older signal', () => {
  const rows = candles(), now = 1021 * 60 * 1000;
  rows[18].close = 109; rows[10].time += 60; rows[20].volume = 0;
  assert.equal(candleSignal({ code: 0, data: { list: rows } }, '1m', now).qualified, true);
  rows.push({ time: 1021 * 60, open: 107, close: 107, high: 107, low: 107, volume: 10 });
  assert.equal(candleSignal({ code: 0, data: { list: rows } }, '1m', now).qualified, true); // forming bar ignored
  assert.equal(candleSignal({ code: 0, data: { list: rows } }, '1m', now + 60000).qualified, false);
});

const reversals = [
  { pattern: 'hammer', open: 103, close: 104, high: 104.5, low: 101 },
  { pattern: 'hammer', open: 104, close: 103, high: 104.5, low: 101 },
  { pattern: 'inverted-hammer', open: 103, close: 104, high: 106, low: 102.5 },
  { pattern: 'inverted-hammer', open: 104, close: 103, high: 106, low: 102.5 }
];

for (const reversal of reversals) {
  test(`closed M1 ${reversal.pattern} (${reversal.close > reversal.open ? 'green' : 'red'}) buys after close and logs its pattern`, () => {
    const rows = candles(), now = 1021 * 60 * 1000;
    rows[20] = { ...rows[20], ...reversal };
    const body = () => ({ code: 0, data: { list: rows } });
    const signal = candleSignal(body(), '1m', now);
    assert.equal(signal.qualified, true);
    assert.equal(signal.pattern, reversal.pattern);
    assert.equal(signal.closedAt, now);
    assert.equal(candleSignal(body(), '1m', now - 1).qualified, false);
    assert.equal(candleSignal(body(), '1m', now + 76000).qualified, false);
    const m5 = candles(300); m5[20] = { ...m5[20], ...reversal };
    assert.equal(candleSignal({ code: 0, data: { list: m5 } }, '5m', 1021 * 300 * 1000).qualified, false);

    const context: any = {}, events: any[] = [];
    runInNewContext(readFileSync('public/strategy.js', 'utf8'), context);
    let time = now - 1;
    const account = context.HermesRules.create((...args: any[]) => events.push(args), () => time);
    account.update([{ address: 'token', price: 104 }], time);
    assert.equal(account.enter('token', signal), false);
    time = now;
    assert.equal(account.enter('token', signal), true);
    assert.equal(events.find((e) => e[1] === 'simulated-buy')[1], 'simulated-buy');
    assert.ok(events.find((e) => e[1] === 'simulated-buy')[3].includes(reversal.pattern.replace('-', ' ')));
    assert.equal(events.find((e) => e[1] === 'simulated-buy')[4].signal.pattern, reversal.pattern);
    assert.equal(account.enter('token', signal), false);
    assert.equal(account.snapshot().cash, 9500);
    assert.equal(account.snapshot().positions.token.entry, 104 * 1.0005);

    rows[20].volume = 0; assert.equal(candleSignal(body(), '1m', now).qualified, true);
    rows[20].volume = 20; rows[18].close = 109;
    assert.equal(candleSignal(body(), '1m', now).qualified, true);
    rows[18].close = 106; rows[10].time += 60;
    assert.equal(candleSignal(body(), '1m', now).qualified, true);
    assert.equal(candleSignal({ code: 0, data: { list: [rows[20]] } }, '1m', now).qualified, true);
  });
}

test('M1 reversal rejects dojis, short main wicks, oversized opposite wicks, and invalid OHLC', () => {
  for (const shape of [
    { open: 103, close: 103, high: 103.5, low: 100 },
    { open: 103, close: 104, high: 104.5, low: 101.01 },
    { open: 103, close: 104, high: 104.51, low: 101 },
    { open: 103, close: 104, high: 105.99, low: 102.5 },
    { open: 103, close: 104, high: 106, low: 102.49 },
    { open: 103, close: 104, high: 102, low: 101 }
  ]) {
    const rows = candles(); rows[20] = { ...rows[20], ...shape };
    assert.equal(candleSignal({ code: 0, data: { list: rows } }, '1m', 1021 * 60 * 1000).qualified, false, JSON.stringify(shape));
  }
});

test('executor permits either pattern only within the immediately next candle, with one buy', () => {
  for (const [resolution, seconds, shape] of [
    ['1m', 60, null], ['5m', 300, null],
    ...reversals.map((shape) => ['1m', 60, shape])
  ] as any[]) {
    const rows = candles(seconds).slice(-2), closedAt = 1021 * seconds * 1000;
    if (shape) Object.assign(rows[1], shape);
    const signal = candleSignal({ code: 0, data: { list: rows } }, resolution, closedAt);
    for (const offset of [-1, 0, seconds * 1000 - 1, seconds * 1000]) {
      const context: any = {}, events: any[] = [];
      runInNewContext(readFileSync('public/strategy.js', 'utf8'), context);
      const time = closedAt + offset;
      const account = context.HermesRules.create((...args: any[]) => events.push(args), () => time);
      account.update([{ address: 'token', price: 104 }], time);
      const expected = offset >= 0 && offset < seconds * 1000;
      assert.equal(account.enter('token', signal), expected);
      if (expected) {
        assert.equal(account.enter('token', signal), false);
        assert.equal(events.filter((e) => e[1] === 'simulated-buy').length, 1);
        assert.match(events.find((e) => e[1] === 'simulated-buy')[3], /entry on the next candle/);
      }
    }
  }
});

test('each buy costs at most 5% of initial capital including fees and slippage', () => {
  const { a, events } = setup();
  const state = a.snapshot(), buy = events.find((e) => e[1] === 'simulated-buy')[4];
  assert.equal(state.initialCapital, 10000);
  assert.equal(state.maxOrderFraction, 0.05);
  assert.equal(state.maxOrderCost, 500);
  assert.equal(state.cash, 9500);
  assert.equal(state.positions.token.cost, 500);
  assert.equal(buy.totalCost, 500);
  assert.ok(Math.abs(buy.quantity * buy.fill + buy.fee - 500) < 1e-10);
  assert.ok(Math.abs(buy.fee - buy.notional * 0.001) < 1e-10);
  assert.equal(buy.fill, 100 * 1.0005);
});

test('profits and losses never compound the initial-capital allocation limit', () => {
  for (const multiple of [0.5, 12]) {
    const { a, quote, signal, now } = setup();
    quote(a.snapshot().positions.token.entry * multiple);
    const before = a.snapshot();
    assert.ok(multiple > 1 ? before.equity > 10000 : before.equity < 10000);
    a.update([{ address: 'next', price: 10 }], now());
    assert.equal(a.enter('next', signal()), true);
    assert.equal(before.cash - a.snapshot().cash, 500);
    assert.equal(a.snapshot().positions.next.cost, 500);
    assert.equal(a.snapshot().maxOrderCost, 500);
  }
});

test('cash budget accepts exactly $500, rejects insufficient cash without a fill, and reset restores initial limits', () => {
  const context: any = {}; runInNewContext(readFileSync('public/strategy.js', 'utf8'), context);
  const events: any[] = [], now = 1000000;
  const account = context.HermesRules.create((...args: any[]) => events.push(args), () => now);
  const signal = { qualified: true, resolution: '1m', closedAt: now, expiresAt: now + 60000 };
  for (let i = 0; i < 21; i++) {
    const address = 'token' + i;
    account.update([{ address, price: 100 }], now);
    assert.equal(account.enter(address, signal), i < 20);
    assert.equal(account.snapshot().cash, Math.max(0, 10000 - (i + 1) * 500));
  }
  assert.equal(events.filter((e) => e[1] === 'simulated-buy').length, 20);
  const reset = context.HermesRules.create(() => {}, () => now).snapshot();
  assert.equal(reset.cash, 10000);
  assert.equal(reset.maxOrderCost, 500);
});
