import assert from 'node:assert/strict';
import test from 'node:test';
import { createPacedRequest } from '../api/_lib/gmgn-request';
import { createSignalFeed } from '../api/_lib/candles';

test('shared pacing waits for lock then refreshes authentication timestamp, and rejects write routes', async () => {
  let time = 100000, tries = 0, calls = 0;
  const db = { get: async () => null, set: async () => ++tries > 10 ? 'OK' : null };
  const request = createPacedRequest(() => db, (async (url: any) => {
    calls++; assert.equal(url.searchParams.get('timestamp'), '110');
    return new Response('{}');
  }) as typeof fetch, () => time, async (ms) => { time += ms; });
  await request('https://openapi.gmgn.ai/v1/market/rank?timestamp=100');
  assert.equal(calls, 1);
  await assert.rejects(request('https://openapi.gmgn.ai/v1/trade/swap'), /not allowed/);
  await assert.rejects(request('https://example.com/v1/market/rank'), /not allowed/);
});

test('rate limited candle request blocks subsequent market requests through the shared gate', async () => {
  let cooldown: unknown = null, calls = 0;
  const db = { get: async () => cooldown, set: async (key: string, value: string | number, options: any) => {
    if (key.includes('cooldown')) { cooldown = value; assert.ok(options.px >= 300000); }
    return 'OK';
  } };
  const request = createPacedRequest(() => db, (async () => { calls++; return new Response('{}', { status: 429 }); }) as typeof fetch, () => 100000);
  await request('https://openapi.gmgn.ai/v1/market/token_kline');
  await assert.rejects(request('https://openapi.gmgn.ai/v1/market/rank'), /cooldown/);
  assert.equal(calls, 1);
});

test('candle adapter calls only Solana M1/M5 read routes and caches per mint', async () => {
  let calls = 0;
  const feed = createSignalFeed((async (url: any) => {
    calls++;
    assert.equal(url.pathname, '/v1/market/token_kline'); assert.equal(url.searchParams.get('chain'), 'sol');
    assert.ok(['1m', '5m'].includes(url.searchParams.get('resolution')));
    return new Response(JSON.stringify({ code: 0, data: { code: 0, data: { list: [] } } }));
  }) as typeof fetch, () => 10000000);
  const mint = 'So11111111111111111111111111111111111111112';
  const [a, b] = await Promise.all([feed(mint, 'placeholder'), feed(mint, 'placeholder')]);
  assert.deepEqual(a, b); assert.equal(calls, 2);
  await feed(mint, 'placeholder'); assert.equal(calls, 2);
  await assert.rejects(feed('invalid', 'placeholder'), /Invalid mint/);
});

test('holding lookup retains valid USD quotes above entry market-cap limits', async () => {
  const { normalizeQuote } = await import('../api/quote');
  const mint = 'So11111111111111111111111111111111111111112';
  const body = { code: 0, data: { code: 0, data: { address: mint, chain: 'sol', price: { price: '100' }, circulating_supply: 1000000 } } };
  assert.equal(normalizeQuote(body, mint, 123).price, 100);
  assert.throws(() => normalizeQuote({ code: 0, data: { chain: 'eth', price: { price: 1 } } }, mint, 123));
  assert.throws(() => normalizeQuote({ code: 0, data: { price: { price: 'NaN' } } }, mint, 123));
});
