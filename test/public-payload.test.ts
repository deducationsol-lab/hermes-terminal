import assert from 'node:assert/strict';
import test from 'node:test';
import { publicPayload, PUBLIC_STRATEGY } from '../api/_lib/public-payload';
import { FOLLOW_WALLET } from '../api/_lib/helius';
test('public masking removes followed-wallet identity from nested history/status/export data without modifying source', () => {
  const input = { message: 'Follow ' + FOLLOW_WALLET, events: [{ meta: { wallet: FOLLOW_WALLET, signature: 'unchanged-signature', token: 'unchanged-mint' } }], status: 'omego…XAfq', equity: 123 };
  const result = publicPayload(input);
  assert.ok(!JSON.stringify(result).includes(FOLLOW_WALLET));
  assert.ok(!JSON.stringify(result).includes('omego…XAfq'));
  assert.equal(result.events[0].meta.wallet, PUBLIC_STRATEGY);
  assert.equal(result.events[0].meta.token, input.events[0].meta.token);
  assert.equal(result.equity, 123); assert.equal(input.events[0].meta.wallet, FOLLOW_WALLET);
});
