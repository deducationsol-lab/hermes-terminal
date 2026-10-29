import assert from 'node:assert/strict';
import test from 'node:test';
import { createRedisClient } from '../api/_lib/redis';

test('Redis accepts paired Marketplace credentials without mixing credential sources', () => {
  const keys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
  const saved = keys.map((key) => process.env[key]);
  try {
    keys.forEach((key) => delete process.env[key]);
    assert.throws(() => createRedisClient(), /Set UPSTASH/);
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'test-placeholder';
    assert.doesNotThrow(() => createRedisClient());
    process.env.UPSTASH_REDIS_REST_URL = 'https://direct.example.upstash.io';
    assert.throws(() => createRedisClient(), /Set UPSTASH/, 'never mix a direct URL with the Marketplace token');
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-placeholder';
    assert.doesNotThrow(() => createRedisClient());
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
});
