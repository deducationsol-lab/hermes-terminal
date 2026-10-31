import assert from 'node:assert/strict';
import test from 'node:test';
import { failureCode } from '../api/_lib/diagnostics';
test('provider fixed-plan refusal classified independently of application state', () => {
  assert.equal(failureCode(new Error('ERR This database has reached current Fixed plan limits. Please upgrade manually')), 'storage_plan_limit');
  assert.equal(failureCode(new Error('Unauthorized')), 'storage_auth');
  assert.equal(failureCode(new Error('fetch failed')), 'dependency_network');
});
