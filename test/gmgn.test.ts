import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketFeed, normalizeRank } from '../api/_lib/gmgn';
const token = { chain: 'sol', address: 'So11111111111111111111111111111111111111112', symbol: 'TEST', price: '0.02', market_cap: '500000', liquidity: '60000' };

test('GMGN normalization strictly limits chain, cap, liquidity and valid token addresses', () => {
  const result = normalizeRank({ code: 0, data: { rank: [token, token,
    { ...token, chain: 'eth' }, { ...token, market_cap: 99999 },
    { ...token, market_cap: 10000001 }, { ...token, liquidity: 40000 },
    { ...token, price: 'NaN' }, { ...token, address: 'not-an-address' }] } });
  assert.equal(normalizeRank({ code: 0, data: { code: 0, data: { rank: [token] } } }).length, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].price, 0.02);
  assert.throws(() => normalizeRank({ code: 401, data: { rank: [] } }));
});

test('GMGN read-only feed caches, coalesces and never serializes credentials', async () => {
  let calls = 0, time = 100000;
  const mock = async (url: any, options: any) => {
    calls++;
    assert.equal(url.origin, 'https://openapi.gmgn.ai');
    assert.equal(url.pathname, '/v1/market/rank');
    assert.equal(url.searchParams.get('chain'), 'sol');
    assert.equal(url.searchParams.get('order_by'), 'volume');
    assert.equal(options.headers['X-APIKEY'], 'test-placeholder');
    return new Response(JSON.stringify({ code: 0, data: { rank: [token] } }));
  };
  const feed = createMarketFeed(mock as typeof fetch, () => time);
  const [a, b] = await Promise.all([feed('test-placeholder'), feed('test-placeholder')]);
  assert.equal(calls, 1); assert.deepEqual(a, b);
  assert.ok(!JSON.stringify(a).includes('test-placeholder'));
  await feed('test-placeholder'); assert.equal(calls, 1);
  time += 21000; await feed('test-placeholder'); assert.equal(calls, 2);
});

test('GMGN failure does not serve stale data and rate-limits retries', async () => {
  let calls = 0;
  const feed = createMarketFeed((async () => { calls++; throw new Error('secret upstream detail'); }) as typeof fetch, () => 100000);
  await assert.rejects(feed('test-placeholder'), /GMGN unavailable/);
  await assert.rejects(feed('test-placeholder'), /temporarily unavailable/);
  assert.equal(calls, 1);
});
