import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LogHub } from '../src/hub';
import type { LogEvent } from '../src/types';

test('publish assigns incrementing seq and a timestamp', () => {
  const hub = new LogHub();
  const before = Date.now();

  const first = hub.publish({ channel: 'alpha', level: 'info', message: 'one' });
  const second = hub.publish({ channel: 'alpha', level: 'info', message: 'two' });

  const after = Date.now();

  assert.equal(first.seq, 0);
  assert.equal(second.seq, 1);
  assert.ok(first.ts >= before && first.ts <= after);
  assert.ok(second.ts >= before && second.ts <= after);
});

test('publish preserves a producer-supplied timestamp', () => {
  const hub = new LogHub();
  const event = hub.publish({ channel: 'alpha', level: 'info', message: 'x', ts: 12345 });
  assert.equal(event.ts, 12345);
});

test('history returns only that channel events in order', () => {
  const hub = new LogHub();
  hub.publish({ channel: 'alpha', level: 'info', message: 'a1' });
  hub.publish({ channel: 'beta', level: 'info', message: 'b1' });
  hub.publish({ channel: 'alpha', level: 'warn', message: 'a2' });

  const alpha = hub.history('alpha');
  assert.deepEqual(
    alpha.map((e) => e.message),
    ['a1', 'a2'],
  );

  const beta = hub.history('beta');
  assert.deepEqual(
    beta.map((e) => e.message),
    ['b1'],
  );
});

test('newly-created channel history starts empty', () => {
  const hub = new LogHub();
  assert.deepEqual(hub.history('never-used'), []);
});

test('subscribe receives published events for its channel only', () => {
  const hub = new LogHub();
  const alphaEvents: LogEvent[] = [];

  hub.subscribe('alpha', (e) => alphaEvents.push(e));

  hub.publish({ channel: 'alpha', level: 'info', message: 'a1' });
  hub.publish({ channel: 'beta', level: 'info', message: 'b1' });
  hub.publish({ channel: 'alpha', level: 'error', message: 'a2' });

  assert.deepEqual(
    alphaEvents.map((e) => e.message),
    ['a1', 'a2'],
  );
});

test('unsubscribe stops delivery', () => {
  const hub = new LogHub();
  const received: string[] = [];

  const unsubscribe = hub.subscribe('alpha', (e) => received.push(e.message));

  hub.publish({ channel: 'alpha', level: 'info', message: 'first' });
  unsubscribe();
  hub.publish({ channel: 'alpha', level: 'info', message: 'second' });

  assert.deepEqual(received, ['first']);
  assert.equal(hub.subscriberCount('alpha'), 0);
});

test('ring buffer capacity is configurable via constructor', () => {
  const hub = new LogHub(2);
  hub.publish({ channel: 'alpha', level: 'info', message: 'a1' });
  hub.publish({ channel: 'alpha', level: 'info', message: 'a2' });
  hub.publish({ channel: 'alpha', level: 'info', message: 'a3' });

  assert.deepEqual(
    hub.history('alpha').map((e) => e.message),
    ['a2', 'a3'],
  );
});
