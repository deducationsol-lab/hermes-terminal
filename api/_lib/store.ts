/**
 * Pure storage logic shared by the serverless handlers.
 *
 * These helpers operate against the minimal {@link RedisLike} surface, so they
 * can be exercised in unit tests with a small in-memory mock and require no
 * live connection. They encapsulate the two operations the transport needs:
 * appending a validated event (assigning a server-side seq and trimming the
 * list) and reading recent history back out.
 *
 * Strictly domain-agnostic.
 */

import type { IngestPayload, LogEvent } from '../../src/types';
import { buildEvent } from './validate';
import { eventsKey, seqKey, LIST_CAP, type RedisLike } from './redis';

/**
 * Append a validated payload to its channel list and return the stored event.
 *
 * Assigns a monotonic seq via INCR. The counter starts at 0 for a channel's
 * first event: INCR returns 1 on first use, and we subtract 1 so the first seq
 * is 0, matching the in-memory hub's starting convention. The event is RPUSHed
 * as JSON, then LTRIM keeps only the most recent {@link LIST_CAP} entries (the
 * ring-buffer analog).
 *
 * @param redis The Redis surface (live or injected mock).
 * @param payload A normalized payload.
 * @param now Current time in ms since epoch, used when payload.ts is absent.
 */
export async function appendEvent(
  redis: RedisLike,
  payload: IngestPayload,
  now: number,
): Promise<LogEvent> {
  const counter = await redis.incr(seqKey(payload.channel));
  const seq = counter - 1;
  const event = buildEvent(payload, seq, now);

  const key = eventsKey(payload.channel);
  await redis.rpush(key, JSON.stringify(event));
  // Keep only the last LIST_CAP entries, dropping the oldest.
  await redis.ltrim(key, -LIST_CAP, -1);

  return event;
}

/**
 * Read the recent history for a channel, oldest-to-newest.
 *
 * Non-JSON or malformed entries are skipped defensively rather than throwing.
 */
export async function readHistory(redis: RedisLike, channel: string): Promise<LogEvent[]> {
  const raw = await redis.lrange(eventsKey(channel), 0, -1);
  const events: LogEvent[] = [];
  for (const entry of raw) {
    const parsed = parseEvent(entry);
    if (parsed) events.push(parsed);
  }
  return events;
}

/**
 * Parse a stored list entry into a LogEvent.
 *
 * The Upstash client may return already-deserialized objects for JSON values,
 * so accept both a JSON string and an object. Returns null on anything invalid.
 */
export function parseEvent(entry: unknown): LogEvent | null {
  let value: unknown = entry;
  if (typeof entry === 'string') {
    try {
      value = JSON.parse(entry);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.channel !== 'string') return null;
  if (typeof obj.message !== 'string') return null;
  if (typeof obj.seq !== 'number') return null;
  if (typeof obj.ts !== 'number') return null;
  return value as LogEvent;
}
