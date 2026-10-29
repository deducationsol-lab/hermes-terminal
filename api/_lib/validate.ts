/**
 * Shared, pure validation and event-construction logic for the serverless
 * functions.
 *
 * This module intentionally has NO dependency on node:http or any transport. It
 * operates on already-parsed data so it can be unit-tested in isolation and
 * reused by both the ingest and stream serverless handlers. The rules here
 * mirror exactly those in src/server.ts (handleIngest) so the serverless path
 * and the local node:http + ws path accept the same inputs and produce the same
 * events.
 *
 * The system is strictly domain-agnostic: it transports arbitrary structured
 * log events and has no knowledge of what they represent.
 */

import type { IngestPayload, LogEvent } from '../../src/types';

/** Maximum accepted request body size, matching src/server.ts readBody. */
export const MAX_BODY_BYTES = 1_000_000; // 1 MB

/** Default severity level applied when a producer omits a string level. */
export const DEFAULT_LEVEL = 'info';

/** A validation failure: an HTTP status and a human-readable error message. */
export interface ValidationError {
  status: 400;
  error: string;
}

/** Result of validating a parsed body: either an error or a normalized payload. */
export type ValidationResult =
  | { ok: true; payload: IngestPayload }
  | { ok: false; error: ValidationError };

/**
 * Validate and normalize an already-parsed request body.
 *
 * Applies the same rules as src/server.ts handleIngest:
 *  - body must be a non-null object
 *  - channel must be a non-empty string
 *  - message must be a non-empty string
 *  - level defaults to 'info' when it is not a string
 *  - meta is included only when it is a non-null object
 *  - ts is honored only when it is a number (non-number ts is dropped)
 *
 * @param parsed The result of JSON-parsing the request body.
 * @returns A normalized {@link IngestPayload} or a {@link ValidationError}.
 */
export function validateIngest(parsed: unknown): ValidationResult {
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: { status: 400, error: 'body must be a JSON object' } };
  }

  const body = parsed as Record<string, unknown>;
  const channel = body.channel;
  const message = body.message;

  if (typeof channel !== 'string' || channel.length === 0) {
    return { ok: false, error: { status: 400, error: 'channel is required' } };
  }
  if (typeof message !== 'string' || message.length === 0) {
    return { ok: false, error: { status: 400, error: 'message is required' } };
  }

  const payload: IngestPayload = {
    channel,
    level: typeof body.level === 'string' ? (body.level as string) : DEFAULT_LEVEL,
    message,
    ...(typeof body.meta === 'object' && body.meta !== null
      ? { meta: body.meta as Record<string, unknown> }
      : {}),
    ...(typeof body.ts === 'number' ? { ts: body.ts } : {}),
  };

  return { ok: true, payload };
}

/**
 * Build a fully-formed {@link LogEvent} from a validated payload.
 *
 * Matches src/hub.ts publish semantics: the timestamp is the producer-supplied
 * `ts` when present, otherwise `now`; `meta` is included only when present; the
 * caller supplies the already-assigned monotonic `seq`.
 *
 * @param payload A normalized payload from {@link validateIngest}.
 * @param seq The sequence number assigned to this event (monotonic per channel).
 * @param now The current time in ms since epoch, used when `payload.ts` is absent.
 */
export function buildEvent(payload: IngestPayload, seq: number, now: number): LogEvent {
  return {
    channel: payload.channel,
    level: payload.level,
    message: payload.message,
    ...(payload.meta !== undefined ? { meta: payload.meta } : {}),
    ts: payload.ts ?? now,
    seq,
  };
}
