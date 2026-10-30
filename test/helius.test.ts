import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySwap, pollWallet, FOLLOW_WALLET, type WalletState } from '../api/_lib/helius';
import { create } from '../public/strategy';
const mint = 'So22222222222222222222222222222222222222222';
function tx(sell = false): any {
  return { blockTime: 1000, slot: 2, transaction: { signatures: ['2'.repeat(88)], message: {
    accountKeys: [{ pubkey: FOLLOW_WALLET, signer: true }], instructions: [{ programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' }] } },
    meta: { err: null, fee: 5000, preBalances: [1000000000], postBalances: [sell ? 1099995000 : 899995000],
      preTokenBalances: [{ owner: FOLLOW_WALLET, mint, uiTokenAmount: { amount: sell ? '100' : '0' } }],
      postTokenBalances: [{ owner: FOLLOW_WALLET, mint, uiTokenAmount: { amount: sell ? '0' : '100' } }] } };
}
test('only supported successful wallet-signed swaps with opposite SOL/token flows classify', () => {
  assert.equal(classifySwap(tx())?.side, 'buy'); assert.equal(classifySwap(tx(true))?.side, 'sell');
  for (const mutate of [
    (x: any) => x.meta.err = {}, (x: any) => x.transaction.message.accountKeys[0].signer = false,
    (x: any) => x.transaction.message.instructions = [], (x: any) => x.meta.postBalances = [999995000],
    (x: any) => x.meta.postTokenBalances.push({ owner: FOLLOW_WALLET, mint: '3'.repeat(32), uiTokenAmount: { amount: '1' } })
  ]) { const row = tx(); mutate(row); assert.equal(classifySwap(row), null); }
});
test('Helius uses read-only confirmed history, deduplicates overlap and fails closed on RPC errors', async () => {
  const previous = process.env.HELIUS_API_KEY; process.env.HELIUS_API_KEY = 'test-placeholder';
  try {
    const state: WalletState = { activatedAt: 999000, through: 999, lastRead: 0, seen: [], queue: [], observed: 0 };
    const request = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)); assert.equal(body.method, 'getTransactionsForAddress');
      assert.equal(body.params[0], FOLLOW_WALLET); assert.equal(body.params[1].commitment, 'confirmed'); assert.equal(body.params[1].maxSupportedTransactionVersion, 1);
      return new Response(JSON.stringify({ result: { data: [tx()], paginationToken: null } }));
    }) as typeof fetch;
    const first = await pollWallet(state, request, () => 1010000);
    assert.equal(first.observed, 1); assert.equal(first.queue.length, 1);
    const second = await pollWallet(first, request, () => 1015000);
    assert.equal(second.observed, 1); assert.equal(second.queue.length, 1);
    await assert.rejects(pollWallet(first, (async () => new Response('{"error":{"message":"private"}}')) as typeof fetch, () => 1015000), /RPC unavailable/);
    assert.equal(first.through, 1005);
    const old = await pollWallet({ ...state, activatedAt: 1001000, through: 1001 }, request, () => 1015000);
    assert.equal(old.queue.length, 0);
  } finally { if (previous === undefined) delete process.env.HELIUS_API_KEY; else process.env.HELIUS_API_KEY = previous; }
});
test('wallet sells retain 10% on profit, deduced after costs, but fully close a losing position', () => {
  for (const price of [110, 99]) {
    let time = 1000000; const a = create(() => {}, () => time);
    a.update([{ address: mint, price: 100, marketCap: 10000 }], time);
    assert.ok(a.enter(mint, { qualified: true, resolution: 'wallet', closedAt: time, expiresAt: time + 120000 }));
    const qty = a.snapshot().positions[mint].qty;
    time++; a.update([{ address: mint, price, marketCap: 10000 }], time);
    assert.ok(a.followSell(mint));
    if (price > 100) assert.ok(Math.abs(a.snapshot().positions[mint].qty / qty - 0.1) < 1e-10);
    else assert.equal(a.holding(mint), false);
    assert.ok(a.excluded(mint));
  }
});

test('behavior observations accumulate supported source flow and last-buy-to-sell timing without retraining', async () => {
  const previous = process.env.HELIUS_API_KEY; process.env.HELIUS_API_KEY = 'test-placeholder';
  try {
    const initial: WalletState = { activatedAt: 999000, through: 999, lastRead: 0, seen: [], queue: [], observed: 0 };
    const buy = tx(), sell = tx(true); sell.blockTime = 1005; sell.transaction.signatures = ['3'.repeat(88)];
    const request = (async () => new Response(JSON.stringify({ result: { data: [buy, sell], paginationToken: null } }))) as typeof fetch;
    const state = await pollWallet(initial, request, () => 1015000);
    assert.equal(state.behavior!.buys, 1); assert.equal(state.behavior!.sells, 1);
    assert.equal(state.behavior!.completedHolds, 1); assert.equal(state.behavior!.totalHoldSeconds, 5);
    assert.equal(state.behavior!.totalBuySol, 0.1); assert.equal(state.behavior!.totalSellSol, 0.1);
    const again = await pollWallet(state, request, () => 1016000);
    assert.deepEqual(again.behavior, state.behavior);
  } finally { if (previous === undefined) delete process.env.HELIUS_API_KEY; else process.env.HELIUS_API_KEY = previous; }
});
