/**
 * Pure, domain-agnostic metrics helpers for a stream of log events.
 *
 * These functions compute simple throughput and counting statistics from an
 * in-memory list of events. They make no assumptions about what the events
 * represent: levels are treated as opaque strings, so custom (non-standard)
 * levels are counted just like the well-known ones.
 *
 * The browser dashboard mirrors the same tiny logic inline; this module is the
 * authoritative, unit-tested copy.
 */

import type { LogEvent } from './types';

/** A single event as far as metrics are concerned: a level and a timestamp. */
export interface MetricEvent {
  /** Severity level (any string; custom levels are allowed). */
  level?: string;
  /** Timestamp in milliseconds since the Unix epoch. */
  ts?: number;
}

/** The computed statistics for a window of events. */
export interface Metrics {
  /** Total number of events considered (the full buffer length). */
  total: number;
  /** Count of events per level string, keyed by the raw level. */
  perLevel: Record<string, number>;
  /** Events observed within the trailing window, expressed per second. */
  eventsPerSec: number;
}

/**
 * Compute metrics for a list of events.
 *
 * @param events  The events to summarise (order does not matter).
 * @param nowMs   The current time in ms since epoch (used as the window end).
 * @param windowMs The trailing window, in ms, used for the events/sec rate.
 *                 Defaults to 1000ms (a one-second rate).
 *
 * `total` is the number of events. `perLevel` counts events by their level
 * string, defaulting an absent level to `'info'`. `eventsPerSec` counts events
 * whose `ts` falls within the trailing window `(nowMs - windowMs, nowMs]` and
 * scales that count to a per-second figure. Events without a numeric `ts` are
 * excluded from the rate but still counted in `total` and `perLevel`.
 */
export function computeMetrics(
  events: ReadonlyArray<MetricEvent | LogEvent>,
  nowMs: number,
  windowMs = 1000,
): Metrics {
  const perLevel: Record<string, number> = {};
  let inWindow = 0;

  const windowStart = nowMs - windowMs;

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const level = typeof event.level === 'string' && event.level.length > 0 ? event.level : 'info';
    perLevel[level] = (perLevel[level] ?? 0) + 1;

    const ts = event.ts;
    if (typeof ts === 'number' && ts > windowStart && ts <= nowMs) {
      inWindow += 1;
    }
  }

  const eventsPerSec = windowMs > 0 ? (inWindow * 1000) / windowMs : 0;

  return {
    total: events.length,
    perLevel,
    eventsPerSec,
  };
}
