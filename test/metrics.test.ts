import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMetrics } from '../src/metrics';
import type { MetricEvent } from '../src/metrics';

test('empty input yields zeroed metrics', () => {
  const m = computeMetrics([], 1000, 1000);
  assert.equal(m.total, 0);
  assert.deepEqual(m.perLevel, {});
  assert.equal(m.eventsPerSec, 0);
});

test('total counts every event regardless of level or timestamp', () => {
  const events: MetricEvent[] = [
    { level: 'info', ts: 1 },
    { level: 'warn', ts: 2 },
    { level: 'error' }, // no ts still counts toward total
  ];
  const m = computeMetrics(events, 1000, 1000);
  assert.equal(m.total, 3);
});

test('per-level counts group by level string including custom levels', () => {
  const events: MetricEvent[] = [
    { level: 'info', ts: 1 },
    { level: 'info', ts: 2 },
    { level: 'warn', ts: 3 },
    { level: 'error', ts: 4 },
    { level: 'audit', ts: 5 }, // custom, non-standard level
    { level: 'audit', ts: 6 }, // custom, non-standard level
  ];
  const m = computeMetrics(events, 1000, 1000);
  assert.deepEqual(m.perLevel, { info: 2, warn: 1, error: 1, audit: 2 });
});

test('a missing level defaults to info', () => {
  const events: MetricEvent[] = [{ ts: 1 }, { level: '', ts: 2 }];
  const m = computeMetrics(events, 1000, 1000);
  assert.deepEqual(m.perLevel, { info: 2 });
});

test('events/sec counts only timestamps inside the trailing window', () => {
  const now = 10000;
  const events: MetricEvent[] = [
    { level: 'info', ts: 8000 }, // outside a 1000ms window
    { level: 'info', ts: 9000 }, // boundary == windowStart, excluded
    { level: 'info', ts: 9500 }, // inside
    { level: 'info', ts: 9999 }, // inside
    { level: 'info', ts: 10000 }, // inside (window end is inclusive)
    { level: 'info', ts: 11000 }, // in the future, excluded
  ];
  const m = computeMetrics(events, now, 1000);
  // 3 events in the trailing 1000ms window -> 3 events/sec.
  assert.equal(m.eventsPerSec, 3);
});

test('events/sec scales the in-window count to a per-second rate', () => {
  const now = 10000;
  const events: MetricEvent[] = [
    { level: 'info', ts: 8100 },
    { level: 'info', ts: 9000 },
    { level: 'info', ts: 9500 },
    { level: 'info', ts: 10000 },
  ];
  // Window of 2000ms captures ts 8100, 9000, 9500, 10000 -> 4 events.
  // 4 events over 2s -> 2 events/sec.
  const m = computeMetrics(events, now, 2000);
  assert.equal(m.eventsPerSec, 2);
});
