import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketFeed, normalizeRank } from '../api/_lib/gmgn';
const token = { chain: 'sol', address: 'So11111111111111111111111111111111111111112', symbol: 'TEST', price: '0.02', market_cap: '500000', liquidity: '1500', volume: '1000', top_10_holder_rate: '0.12', creation_timestamp: 1700000000,
  twitter_username: 'test', renounced_mint: 1, renounced_freeze_account: 1, burn_status: 'burn' };
const now = (1700000000 + 500 * 60) * 1000;

test('GMGN normalization strictly limits chain, cap, liquidity and valid token addresses', () => {
  const result = normalizeRank({ code: 0, data: { rank: [token, token,
    { ...token, chain: 'eth' }, { ...token, market_cap: 4999 },
    { ...token, volume: 999 }, { ...token, liquidity: 1499 },
    { ...token, price: 'NaN' }, { ...token, address: 'not-an-address' }] } }, now);
  assert.equal(normalizeRank({ code: 0, data: { code: 0, data: { rank: [token] } } }, now).length, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].price, 0.02);
  assert.throws(() => normalizeRank({ code: 401, data: { rank: [] } }));
});

test('GMGN read-only feed caches, coalesces and never serializes credentials', async () => {
  let calls = 0, time = now;
  const mock = async (url: any, options: any) => {
    calls++;
    assert.equal(url.origin, 'https://openapi.gmgn.ai');
    assert.equal(url.pathname, '/v1/market/rank');
    assert.equal(url.searchParams.get('chain'), 'sol');
    assert.equal(url.searchParams.get('order_by'), 'volume');
    assert.equal(url.searchParams.get('interval'), '5m');
    assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(url.searchParams.has('min_marketcap'), false);
    assert.equal(url.searchParams.has('min_liquidity'), false);
    assert.equal(url.searchParams.has('min_volume'), false);
    assert.equal(url.searchParams.has('max_marketcap'), false);
    assert.deepEqual(url.searchParams.getAll('filters'), []);
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

const rank = (items: any[]) => ({ code: 0, data: { rank: items } });
test('inclusive filters, no cap ceiling, and fail-closed required fields', () => {
  assert.equal(normalizeRank(rank([token]), now)[0].ageMinutes, 500);
  assert.equal(normalizeRank(rank([{ ...token, market_cap: 5000, top_10_holder_rate: 0.28 }]), now).length, 1);
  assert.equal(normalizeRank(rank([{ ...token, market_cap: 1e9 }]), now).length, 1);
  for (const patch of [
    { top_10_holder_rate: 0.1199 }, { top_10_holder_rate: 0.2801 }, { top_10_holder_rate: 12 },
    { creation_timestamp: token.creation_timestamp - 1 }, { creation_timestamp: now / 1000 + 1 },
    { creation_timestamp: null }, { creation_timestamp: token.creation_timestamp * 1000 },
    { twitter_username: '', website: '', telegram: '' }, { twitter_username: '   ' },
    { twitter_username: '<script>' }, { renounced_mint: 0 }, { renounced_freeze_account: false },
    { burn_status: 'none' }, { burn_status: 'locked' }, { burn_status: true }
  ]) assert.equal(normalizeRank(rank([{ ...token, ...patch }]), now).length, 0, JSON.stringify(patch));
  for (const field of ['market_cap', 'liquidity', 'volume', 'price', 'top_10_holder_rate', 'creation_timestamp',
    'renounced_mint', 'renounced_freeze_account', 'burn_status']) {
    for (const missing of [undefined, null, '', 'unknown', 'NaN']) {
      assert.equal(normalizeRank(rank([{ ...token, [field]: missing }]), now).length, 0, `${field}=${missing}`);
    }
  }
  for (const social of [{ website: 'https://example.org' }, { telegram: 'https://t.me/example' }]) {
    assert.equal(normalizeRank(rank([{ ...token, twitter_username: '', ...social }]), now).length, 1);
  }
});

test('raw top 20 selected before filters; rank 21 never backfills and no 1h request', async () => {
  let calls = 0;
  const rows = Array.from({ length: 21 }, (_, i) => ({ ...token, address: '123456789ABCDEFGHJKLMNPQRSTUVWXYZ'[i].repeat(32), volume: i === 0 ? 999 : 2000 }));
  const feed = createMarketFeed((async (url: any) => {
    calls++; assert.equal(url.searchParams.get('interval'), '5m');
    return new Response(JSON.stringify(rank(rows)));
  }) as typeof fetch, () => now);
  const snapshot = await feed('placeholder');
  assert.equal(calls, 1); assert.equal(snapshot.tokens.length, 19);
  assert.ok(!snapshot.tokens.some(t => t.address === rows[20].address));
  assert.ok(snapshot.tokens.every(t => t.trending.length === 1 && t.trending[0] === '5m' && t.volumes['5m'] === 2000 && t.volumes['1h'] === undefined));
});

test('five-minute feed failure closes entries without any alternate-window fallback', async () => {
  let calls = 0;
  const feed = createMarketFeed((async () => { calls++; return new Response('{}', { status: 429 }); }) as typeof fetch, () => now);
  await assert.rejects(feed('placeholder'), /unavailable/);
  await assert.rejects(feed('placeholder'), /temporarily unavailable/);
  assert.equal(calls, 1);
});

test('cached tokens age out rather than remaining entry-eligible beyond 500 minutes', async () => {
  let time = now;
  const feed = createMarketFeed((async () => new Response(JSON.stringify(rank([token])))) as typeof fetch, () => time);
  assert.equal((await feed('placeholder')).tokens.length, 1);
  time += 1000;
  assert.equal((await feed('placeholder')).tokens.length, 0);
});

test('pool highlights use provider quote symbol, not base token name; missing stays unknown', async () => {
  const { normalizeQuote } = await import('../api/quote');
  for (const symbol of ['WSOL', 'USDC', 'USD1', 'SOL']) {
    const quote = normalizeQuote({ code: 0, data: { price: { price: 1 }, pool: { quote_symbol: symbol, quote_address: 'reported-mint' } } }, token.address, now);
    assert.equal(quote.highlightedQuote, true); assert.equal(quote.quoteSymbol, symbol);
  }
  const unknown = normalizeQuote({ code: 0, data: { price: { price: 1 }, symbol: 'USDC' } }, token.address, now);
  assert.equal(unknown.highlightedQuote, false); assert.equal(unknown.quoteSymbol, null);
});
