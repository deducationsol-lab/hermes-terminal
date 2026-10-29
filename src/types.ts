/**
 * Shared, domain-agnostic types for the log streaming system.
 *
 * The system streams arbitrary structured log events. It has no knowledge of
 * what the events represent; it only cares about a channel, a severity level,
 * a human-readable message, and optional structured metadata.
 */

/**
 * Well-known severity levels. Any other string is also accepted so producers
 * can use custom levels if they wish.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * A level is one of the well-known levels or any other free-form string.
 */
export type Level = LogLevel | (string & {});

/**
 * A fully-formed log event as stored and broadcast by the hub.
 *
 * `ts` (timestamp, ms since epoch) and `seq` (per-hub monotonic sequence
 * number) are always present on stored events; the hub assigns them when a
 * producer does not supply them.
 */
export interface LogEvent {
  /** Name of the channel this event belongs to. */
  channel: string;
  /** Severity level. */
  level: Level;
  /** Human-readable message. */
  message: string;
  /** Optional arbitrary structured metadata. */
  meta?: Record<string, unknown>;
  /** Timestamp in milliseconds since the Unix epoch. */
  ts: number;
  /** Monotonically increasing sequence number assigned by the hub. */
  seq: number;
}

/**
 * The input payload a producer sends to the ingest endpoint.
 *
 * `ts` and `seq` are optional: if omitted they are assigned by the hub when
 * the event is published.
 */
export interface IngestPayload {
  channel: string;
  level: Level;
  message: string;
  meta?: Record<string, unknown>;
  /** Optional producer-supplied timestamp (ms since epoch). */
  ts?: number;
  /** Optional producer-supplied sequence number (normally hub-assigned). */
  seq?: number;
}
