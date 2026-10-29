/**
 * Redis key conventions and an injectable @upstash/redis client factory.
 *
 * Cross-invocation state for the serverless transport lives in Upstash Redis.
 * Two keys per channel:
 *  - a trimmed list of JSON-serialized LogEvents (the analog of the in-memory
 *    ring buffer in src/hub.ts), trimmed to the last LIST_CAP entries; and
 *  - a monotonic sequence counter advanced with INCR so seq is assigned
 *    server-side and stays consistent across stateless invocations.
 *
 * The client is INJECTABLE: handlers resolve it through a factory so unit tests
 * can pass a small in-memory mock instead of opening a live connection. The
 * sandbox has no live Upstash credentials, so this keeps the pure logic fully
 * testable.
 *
 * This module is strictly domain-agnostic.
 */

import { Redis } from '@upstash/redis';

/**
 * Maximum number of events retained per channel list. Matches the in-memory
 * ring buffer default capacity (RING_BUFFER_SIZE) in the local server.
 */
export const LIST_CAP = 500;

/** Namespace prefix for all keys written by this service. */
const KEY_PREFIX = 'hermes:channel:';

/** Key of the per-channel trimmed list holding JSON-serialized LogEvents. */
export function eventsKey(channel: string): string {
  return `${KEY_PREFIX}${channel}:events`;
}

/** Key of the per-channel monotonic sequence counter advanced with INCR. */
export function seqKey(channel: string): string {
  return `${KEY_PREFIX}${channel}:seq`;
}

/**
 * The minimal Redis surface used by the handlers.
 *
 * Declaring it as an interface lets tests supply an in-memory implementation
 * that satisfies exactly these methods without depending on a live connection.
 */
export interface RedisLike {
  incr(key: string): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

/**
 * Build an @upstash/redis client from the generic environment variables
 * UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or the paired
 * KV_REST_API_URL and KV_REST_API_TOKEN injected by Vercel Marketplace.
 *
 * @throws If neither complete credential pair is configured.
 */
export function createRedisClient(): RedisLike {
  const directUrl = process.env.UPSTASH_REDIS_REST_URL;
  const directToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const useDirect = Boolean(directUrl || directToken);
  const url = useDirect ? directUrl : process.env.KV_REST_API_URL;
  const token = useDirect ? directToken : process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or KV_REST_API_URL and KV_REST_API_TOKEN',
    );
  }
  return new Redis({ url, token }) as unknown as RedisLike;
}

/**
 * Resolve a Redis client, preferring an injected one.
 *
 * Handlers call this so tests can inject a mock; when none is provided it falls
 * back to a live client built from the environment.
 */
export function resolveRedis(injected?: RedisLike): RedisLike {
  return injected ?? createRedisClient();
}
