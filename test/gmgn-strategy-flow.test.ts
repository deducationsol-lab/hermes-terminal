import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('dashboard flow requires candle qualification, skips stopped token and scans replacement', async () => {
  let time = 1000000, price = 100, qualified = false;
  const context: any = { Date: class extends Date { static now() { return time; } }, AbortController };
  runInNewContext(readFileSync('public/strategy.js', 'utf8'), context);
  runInNewContext(readFileSync('public/gmgn.js', 'utf8'), context);
  const events: any[] = [], timers = new Map<number, { fn: () => void; ms: number }>();
  let id = 0;
  const token = (address: string, p: number) => ({ address, symbol: address, price: p, ageMinutes: 1, marketCap: 500000, liquidity: 100000 });
  const demo = context.HermesGmgn.create({ channel: 'test', emit: (event: any) => events.push(event), status: () => {},
    setTimeout: (fn: () => void, ms: number) => { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: (key: number) => timers.delete(key),
    fetch: async (path: string) => ({ ok: true, json: async () => path === '/api/market'
      ? { chain: 'sol', source: 'GMGN', fetchedAt: time, tokens: [token('first', price), token('replacement', 10)] }
      : path.startsWith('/api/quote') ? { chain: 'sol', address: new URL(path, 'https://example.com').searchParams.get('address'),
          price: 100, fetchedAt: time, quoteSymbol: 'WSOL', quoteAddress: 'reported-mint', highlightedQuote: true }
      : { chain: 'sol', address: new URL(path, 'https://example.com').searchParams.get('address'),
        signals: [{ qualified, resolution: '1m', closedAt: time - 1000, expiresAt: time + 59000 }] } })
  });
  const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };
  const next = async () => {
    const entry = [...timers.entries()].find(([, t]) => t.ms === 25000)!;
    assert.ok(entry); timers.delete(entry[0]); time += 25000; entry[1].fn(); await flush();
  };
  demo.start(); await flush();
  assert.ok(!events.some((e) => e.meta.kind === 'simulated-buy'));
  assert.ok(events.some((e) => e.meta.kind === 'pair-check' && e.meta.quoteSymbol === 'WSOL' && e.meta.highlightedQuote));
  qualified = true;
  await next(); // replacement candidate
  await next(); // first candidate
  assert.ok(events.some((e) => e.meta.kind === 'simulated-buy' && e.meta.address === 'first'));
  price = 50;
  await next();
  assert.ok(events.some((e) => e.meta.kind === 'stop-loss' && e.meta.address === 'first'));
  assert.ok(events.some((e) => e.meta.kind === 'skip-token' && e.meta.address === 'first'));
  const originalBuys = events.filter((e) => e.meta.kind === 'simulated-buy' && e.meta.address === 'first').length;
  await next();
  assert.equal(events.filter((e) => e.meta.kind === 'simulated-buy' && e.meta.address === 'first').length, originalBuys);
  demo.stop(); assert.equal(timers.size, 0);
});

test('unheld tokens leaving filters free watch slots; held tokens still receive independent quotes', async () => {
  let time = 1000000, round = 0;
  const context: any = { Date: class extends Date { static now() { return time; } }, AbortController };
  runInNewContext(readFileSync('public/strategy.js', 'utf8'), context);
  runInNewContext(readFileSync('public/gmgn.js', 'utf8'), context);
  const events: any[] = [], requests: string[] = [], timers = new Map<number, { fn: () => void; ms: number }>();
  let id = 0;
  const token = (address: string) => ({ address, symbol: address, price: 100, ageMinutes: 1 });
  const demo = context.HermesGmgn.create({ channel: 'test', emit: (e: any) => events.push(e), status: () => {},
    setTimeout: (fn: () => void, ms: number) => { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: (key: number) => timers.delete(key),
    fetch: async (path: string) => {
      requests.push(path);
      const address = new URL(path, 'https://example.com').searchParams.get('address');
      return { ok: true, json: async () => path === '/api/market'
        ? { chain: 'sol', source: 'GMGN', fetchedAt: time, tokens: (round === 0 ? ['a', 'b', 'c', 'd'] : round === 1 ? [] : ['replacement']).map(token) }
        : path.startsWith('/api/quote') ? { chain: 'sol', address, price: 100, fetchedAt: time, quoteSymbol: null, highlightedQuote: false }
        : { chain: 'sol', address, signals: [{ qualified: true, resolution: '1m', closedAt: time - 1000, expiresAt: time + 59000 }] } };
    }
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const next = async () => {
    const entry = [...timers.entries()].find(([, t]) => t.ms === 25000)!;
    timers.delete(entry[0]); time += 25000; round++; entry[1].fn(); await flush();
  };
  demo.start(); await flush();
  assert.ok(events.some((e) => e.meta.kind === 'simulated-buy' && e.meta.address === 'a'));
  await next();
  assert.ok(events.some((e) => e.meta.kind === 'no-eligible-tokens'));
  assert.ok(events.some((e) => e.meta.kind === 'holding-quote' && e.meta.address === 'a'));
  await next();
  assert.ok(events.some((e) => e.meta.kind === 'watch' && e.meta.address === 'replacement'));
  assert.ok(!requests.slice(1).some((r) => /address=[bcd]$/.test(r)));
  demo.stop();
});
