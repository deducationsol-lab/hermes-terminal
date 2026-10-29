import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RingBuffer } from '../src/ringBuffer';

test('respects capacity and drops oldest items', () => {
  const rb = new RingBuffer<number>(3);
  rb.push(1);
  rb.push(2);
  rb.push(3);
  rb.push(4); // should drop 1
  rb.push(5); // should drop 2

  assert.deepEqual(rb.toArray(), [3, 4, 5]);
});

test('toArray returns items oldest-to-newest', () => {
  const rb = new RingBuffer<string>(5);
  rb.push('a');
  rb.push('b');
  rb.push('c');

  assert.deepEqual(rb.toArray(), ['a', 'b', 'c']);
});

test('size never exceeds capacity', () => {
  const rb = new RingBuffer<number>(2);
  assert.equal(rb.size, 0);

  rb.push(1);
  assert.equal(rb.size, 1);

  rb.push(2);
  assert.equal(rb.size, 2);

  rb.push(3);
  assert.equal(rb.size, 2);
  assert.equal(rb.capacity, 2);
});

test('empty buffer returns an empty array', () => {
  const rb = new RingBuffer<number>(4);
  assert.deepEqual(rb.toArray(), []);
});

test('clear resets the buffer', () => {
  const rb = new RingBuffer<number>(3);
  rb.push(1);
  rb.push(2);
  rb.clear();

  assert.equal(rb.size, 0);
  assert.deepEqual(rb.toArray(), []);
});

test('rejects a non-positive capacity', () => {
  assert.throws(() => new RingBuffer<number>(0), RangeError);
  assert.throws(() => new RingBuffer<number>(-1), RangeError);
});
