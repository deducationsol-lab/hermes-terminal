import assert from 'node:assert/strict';
import test from 'node:test';
import { runPollingWindow } from '../api/_lib/polling';
test('bounded worker starts its second serial check 30 seconds after first start', async () => {
  let time = 0; const starts: number[] = [];
  const result = await runPollingWindow(async () => { starts.push(time); time += 10000; return 'ok'; }, () => time, async ms => { time += ms; });
  assert.deepEqual(starts, [0, 30000]); assert.equal(result.checks.length, 2);
});
test('slow first check never overlaps or sleeps extra; errors propagate instead of detaching work', async () => {
  let time = 0; const starts: number[] = [];
  await runPollingWindow(async () => { starts.push(time); time += 45000; }, () => time, async () => { assert.fail('No sleep for slow check'); });
  assert.deepEqual(starts, [0, 45000]);
  await assert.rejects(runPollingWindow(async () => { throw new Error('store unavailable'); }), /store unavailable/);
});

test('second check accounts for Redis lock/read latency before the persisted first start', async () => {
  let time = 0; const starts: number[] = [];
  await runPollingWindow(async () => { time += 250; const lastAttempt = time; starts.push(time); time += 1000; return { lastAttempt }; }, () => time, async ms => { time += ms; });
  assert.ok(starts[1] - starts[0] >= 30000);
});
