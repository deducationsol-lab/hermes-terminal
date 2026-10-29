import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateIngest, buildEvent } from '../api/_lib/validate';
import { appendEvent, readHistory, parseEvent, sortBySeq } from '../api/_lib/store';
import { eventsKey, seqKey, LIST_CAP, type RedisLike } from '../api/_lib/redis';
import type { LogEvent } from '../src/types';

/**
 * Minimal in-memory Redis implementing only the methods the handlers use.
 * Lets us exercise storage logic with no live connection.
 */
class MockRedis implements RedisLike {
  private counters = new Map<string, number>();
  private lists = new Map<string, string[]>();

  async incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<unknown> {
    const list = this.lists.get(key) ?? [];
    const len = list.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;
    this.lists.set(key, list.slice(s, e + 1));
    return 'OK';
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const len = list.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;
    return list.slice(s, e + 1);
  }
}

// --- validation: success cases ---

test('validateIngest normalizes a well-formed body and defaults level to info', () => {
  const result = validateIngest({ channel: 'alpha', message: 'hello' });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.payload.channel, 'alpha');
  assert.equal(result.payload.message, 'hello');
  assert.equal(result.payload.level, 'info');
  assert.equal(result.payload.meta, undefined);
  assert.equal(result.payload.ts, undefined);
});

test('validateIngest includes meta only when it is a non-null object', () => {
  const withMeta = validateIngest({ channel: 'a', message: 'm', meta: { k: 1 } });
  assert.ok(withMeta.ok);
  if (withMeta.ok) assert.deepEqual(withMeta.payload.meta, { k: 1 });

  const nullMeta = validateIngest({ channel: 'a', message: 'm', meta: null });
  assert.ok(nullMeta.ok);
  if (nullMeta.ok) assert.equal(nullMeta.payload.meta, undefined);

  const stringMeta = validateIngest({ channel: 'a', message: 'm', meta: 'nope' });
  assert.ok(stringMeta.ok);
  if (stringMeta.ok) assert.equal(stringMeta.payload.meta, undefined);
});

test('validateIngest honors a numeric ts and strips a non-number ts', () => {
  const numeric = validateIngest({ channel: 'a', message: 'm', ts: 12345 });
  assert.ok(numeric.ok);
  if (numeric.ok) assert.equal(numeric.payload.ts, 12345);

  const stringTs = validateIngest({ channel: 'a', message: 'm', ts: '12345' });
  assert.ok(stringTs.ok);
  if (stringTs.ok) assert.equal(stringTs.payload.ts, undefined);
});

test('validateIngest keeps a non-string level as info', () => {
  const result = validateIngest({ channel: 'a', message: 'm', level: 42 });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.payload.level, 'info');
});

// --- validation: failure cases ---

test('validateIngest rejects a non-object body with status 400', () => {
  for (const body of [null, 'string', 42, true, undefined]) {
    const result = validateIngest(body);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.status, 400);
  }
});

test('validateIngest rejects an empty or missing channel with status 400', () => {
  const missing = validateIngest({ message: 'm' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.status, 400);

  const empty = validateIngest({ channel: '', message: 'm' });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error.status, 400);
});

test('validateIngest rejects an empty or missing message with status 400', () => {
  const missing = validateIngest({ channel: 'a' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.status, 400);

  const empty = validateIngest({ channel: 'a', message: '' });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error.status, 400);
});

// --- buildEvent ---

test('buildEvent produces the correct LogEvent shape with explicit seq and now', () => {
  const event = buildEvent({ channel: 'a', level: 'warn', message: 'm' }, 7, 1000);
  assert.deepEqual(event, { channel: 'a', level: 'warn', message: 'm', ts: 1000, seq: 7 });
});

test('buildEvent prefers a supplied ts over now and includes meta when present', () => {
  const event = buildEvent(
    { channel: 'a', level: 'info', message: 'm', meta: { x: 1 }, ts: 500 },
    3,
    9999,
  );
  assert.deepEqual(event, {
    channel: 'a',
    level: 'info',
    message: 'm',
    meta: { x: 1 },
    ts: 500,
    seq: 3,
  });
});

// --- parseEvent ---

test('parseEvent accepts a JSON string and an object, rejects malformed entries', () => {
  const valid = { channel: 'a', level: 'info', message: 'm', ts: 1, seq: 0 };
  assert.deepEqual(parseEvent(JSON.stringify(valid)), valid);
  assert.deepEqual(parseEvent(valid), valid);
  assert.equal(parseEvent('{not json'), null);
  assert.equal(parseEvent(null), null);
  assert.equal(parseEvent({ channel: 'a' }), null);
});

// --- storage against the in-memory mock ---

test('appendEvent appends to the channel list and assigns seq starting at 0', async () => {
  const redis = new MockRedis();
  const first = await appendEvent(redis, { channel: 'c1', level: 'info', message: 'one' }, 100);
  const second = await appendEvent(redis, { channel: 'c1', level: 'info', message: 'two' }, 200);

  assert.equal(first.seq, 0);
  assert.equal(second.seq, 1);

  const history = await readHistory(redis, 'c1');
  assert.deepEqual(history.map((e) => e.message), ['one', 'two']);
  assert.deepEqual(history.map((e) => e.seq), [0, 1]);
});

test('appendEvent trims the list to the cap, keeping the most recent events', async () => {
  const redis = new MockRedis();
  const total = LIST_CAP + 10;
  for (let i = 0; i < total; i += 1) {
    await appendEvent(redis, { channel: 'c2', level: 'info', message: `m${i}` }, 0);
  }

  const history = await readHistory(redis, 'c2');
  assert.equal(history.length, LIST_CAP);
  // Oldest 10 dropped; first retained should be m10 with seq 10.
  assert.equal(history[0].message, 'm10');
  assert.equal(history[0].seq, 10);
  assert.equal(history[history.length - 1].message, `m${total - 1}`);
  // seq stays monotonic and non-decreasing.
  for (let i = 1; i < history.length; i += 1) {
    assert.ok(history[i].seq > history[i - 1].seq);
  }
});

test('key helpers follow the hermes:channel namespace convention', () => {
  assert.equal(eventsKey('demo'), 'hermes:channel:demo:events');
  assert.equal(seqKey('demo'), 'hermes:channel:demo:seq');
});

test('seq counters are independent per channel', async () => {
  const redis = new MockRedis();
  const a = await appendEvent(redis, { channel: 'x', level: 'info', message: 'a' }, 0);
  const b = await appendEvent(redis, { channel: 'y', level: 'info', message: 'b' }, 0);
  assert.equal(a.seq, 0);
  assert.equal(b.seq, 0);
});

// --- sortBySeq (ordering fix for out-of-order list appends) ---

function ev(seq: number, message: string): LogEvent {
  return { channel: 'c', level: 'info', message, ts: seq, seq };
}

test('sortBySeq orders events by ascending seq regardless of input order', () => {
  const sorted = sortBySeq([ev(2, 'c'), ev(0, 'a'), ev(1, 'b')]);
  assert.deepEqual(sorted.map((e) => e.seq), [0, 1, 2]);
  assert.deepEqual(sorted.map((e) => e.message), ['a', 'b', 'c']);
});

test('sortBySeq is stable for equal seq values', () => {
  const first = ev(5, 'first');
  const second = ev(5, 'second');
  const sorted = sortBySeq([first, second]);
  // Equal seq keeps original relative order.
  assert.equal(sorted[0].message, 'first');
  assert.equal(sorted[1].message, 'second');
});

test('sortBySeq does not mutate its input', () => {
  const input = [ev(1, 'b'), ev(0, 'a')];
  const sorted = sortBySeq(input);
  assert.deepEqual(input.map((e) => e.seq), [1, 0]);
  assert.deepEqual(sorted.map((e) => e.seq), [0, 1]);
});

test('readHistory returns events in seq order even when appended out of order', async () => {
  // Simulate a non-atomic INCR/RPUSH interleaving: the later-seq event is
  // RPUSHed to the list before the earlier-seq one. readHistory must still
  // return them ordered by seq so the tail/history never shows a reversal.
  const redis = new MockRedis();
  const key = eventsKey('race');
  await redis.rpush(key, JSON.stringify(ev(1, 'second')));
  await redis.rpush(key, JSON.stringify(ev(0, 'first')));

  const history = await readHistory(redis, 'race');
  assert.deepEqual(history.map((e) => e.seq), [0, 1]);
  assert.deepEqual(history.map((e) => e.message), ['first', 'second']);
});
