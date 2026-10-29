import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

function load(): any {
  const context: any = {};
  runInNewContext(readFileSync('public/paper.js', 'utf8'), context);
  return context.HermesPaper;
}

test('paper fills use live validated quotes, capped allocation, fees and adverse slippage', () => {
  let now = 100000;
  const events: any[] = [];
  const account = load().engine((...args: any[]) => events.push(args), () => now);
  assert.equal(account.step(), false);
  account.quote('BTCUSDT', 100, now); account.quote('ETHUSDT', 50, now);
  assert.equal(account.step(), true);
  assert.equal(Object.keys(account.snapshot().positions).length, 0);
  now += 5000;
  account.quote('BTCUSDT', 101, now); account.quote('ETHUSDT', 50, now);
  account.step();
  const bought = account.snapshot();
  assert.equal(bought.cash, 9499.5);
  assert.equal(bought.positions.BTCUSDT.entry, 101 * 1.0005);
  assert.ok(bought.pnl < 0);
  assert.ok(events.some((event) => event[1] === 'paper-buy'));
  now += 5000;
  account.quote('BTCUSDT', 100, now); account.quote('ETHUSDT', 50, now);
  account.step();
  const sold = account.snapshot();
  const proceeds = bought.positions.BTCUSDT.qty * 100 * 0.9995 * 0.999;
  assert.ok(Math.abs(sold.cash - (9499.5 + proceeds)) < 1e-8);
  assert.ok(Math.abs(sold.realized - (proceeds - 500.5)) < 1e-8);
  assert.equal(Object.keys(sold.positions).length, 0);
});

test('stale, invalid, out-of-order and future data never cause fills; resumption warms up', () => {
  let now = 100000;
  const account = load().engine(() => {}, () => now);
  assert.equal(account.quote('BTCUSDT', NaN, now), false);
  assert.equal(account.quote('BTCUSDT', -1, now), false);
  assert.equal(account.quote('OTHER', 100, now), false);
  assert.equal(account.quote('BTCUSDT', 100, now - 16000), false);
  assert.equal(account.quote('BTCUSDT', 100, now + 6000), false);
  account.quote('BTCUSDT', 100, now); account.quote('ETHUSDT', 50, now); account.step();
  assert.equal(account.quote('BTCUSDT', 900, now - 1), false);
  now += 20000;
  assert.equal(account.step(), false);
  account.quote('BTCUSDT', 200, now); account.quote('ETHUSDT', 100, now);
  account.step();
  assert.equal(account.snapshot().cash, 10000);
});

test('transport pause blocks account steps and stop releases sockets and timers', () => {
  const api = load();
  let interval: () => void = () => {};
  let socket: any;
  let closed = 0, cleared = 0;
  class FakeSocket {
    readyState = 1; onmessage: any; onclose: any; onerror: any;
    constructor(public url: string) { socket = this; }
    close() { closed++; }
  }
  const events: any[] = [];
  const demo = api.create({ channel: 'paper', WebSocket: FakeSocket,
    emit: (event: any) => events.push(event), status: () => {},
    setInterval: (fn: () => void) => { interval = fn; return 1; }, clearInterval: () => cleared++,
    setTimeout: () => 2, clearTimeout: () => {} });
  demo.start(); demo.start();
  assert.match(socket.url, /^wss:\/\/data-stream.binance.vision/);
  const stamp = Date.now();
  ['BTCUSDT', 'ETHUSDT'].forEach((s) => socket.onmessage({ data: JSON.stringify({ data: { s, p: '100', T: stamp } }) }));
  demo.pause(true); const count = events.length; interval(); assert.equal(events.length, count);
  demo.pause(false); interval();
  assert.ok(events.some((event) => event.meta.kind === 'account'));
  demo.stop(); demo.stop(); assert.equal(closed, 1); assert.equal(cleared, 1);
});
