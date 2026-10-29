/**
 * A runnable demo producer.
 *
 * Emits a continuous stream of generic application log lines to a channel using
 * the LogClient helper. This is purely illustrative: the content is ordinary
 * server/application logging and is intentionally domain-agnostic.
 *
 * Usage:
 *   npm run demo                      # channel "demo", server http://localhost:4000
 *   npm run demo -- my-channel        # override channel via argv
 *   DEMO_CHANNEL=ops DEMO_URL=http://localhost:4000 npm run demo
 *   DEMO_INTERVAL_MS=250 npm run demo # emit faster
 */

import { LogClient } from '../src/client';

const baseUrl = process.env.DEMO_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const channel = process.argv[2] ?? process.env.DEMO_CHANNEL ?? 'demo';
const intervalMs = Number(process.env.DEMO_INTERVAL_MS ?? 800);

const client = new LogClient({ baseUrl, channel });

/** A scripted log line: the level, a message, and optional metadata. */
interface ScriptedLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}

const paths = ['/', '/health', '/api/items', '/api/items/42', '/assets/app.js', '/login'];
const methods = ['GET', 'POST', 'PUT', 'DELETE'];
const workers = ['w-1', 'w-2', 'w-3', 'w-4'];
const regions = ['us-1', 'us-2', 'eu-1', 'eu-2', 'ap-1'];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Generic infrastructure/application telemetry attached to every line so the
 * dashboard metrics strip and ticker have varied, domain-agnostic data to
 * surface. None of these fields carry any business/financial meaning.
 */
function baseMeta(): Record<string, unknown> {
  return {
    worker: pick(workers),
    region: pick(regions),
    queueDepth: randInt(0, 64),
    activeConnections: randInt(1, 200),
    cacheHitRatio: Math.round(Math.random() * 100) / 100,
    bytesOut: randInt(256, 1_048_576),
  };
}

/** Produce the next generic log line, weighted toward info/debug. */
function nextLine(): ScriptedLine {
  const roll = Math.random();
  const method = pick(methods);
  const requestPath = pick(paths);

  if (roll < 0.08) {
    return {
      level: 'error',
      message: 'request failed with unhandled exception',
      meta: { ...baseMeta(), method, path: requestPath, status: 500, durationMs: 120 + Math.floor(Math.random() * 400) },
    };
  }
  if (roll < 0.2) {
    return {
      level: 'warn',
      message: 'slow response detected',
      meta: { ...baseMeta(), method, path: requestPath, status: 200, durationMs: 800 + Math.floor(Math.random() * 1200) },
    };
  }
  if (roll < 0.45) {
    return {
      level: 'debug',
      message: 'cache miss, loading from store',
      meta: { ...baseMeta(), key: `item:${Math.floor(Math.random() * 1000)}` },
    };
  }
  return {
    level: 'info',
    message: 'handling request',
    meta: { ...baseMeta(), method, path: requestPath, status: 200, durationMs: 10 + Math.floor(Math.random() * 90) },
  };
}

async function emit(line: ScriptedLine): Promise<void> {
  try {
    await client.log(line.level, line.message, line.meta);
  } catch (err) {
    // The server may not be up yet; log and keep trying on the next tick.
    // eslint-disable-next-line no-console
    console.error(`failed to emit log: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`demo producer -> ${baseUrl} channel="${channel}" every ${intervalMs}ms (Ctrl+C to stop)`);

  await emit({
    level: 'info',
    message: 'server started',
    meta: { pid: process.pid, worker: pick(workers), region: pick(regions) },
  });

  const timer = setInterval(() => {
    void emit(nextLine());
  }, intervalMs);

  const shutdown = (): void => {
    clearInterval(timer);
    // eslint-disable-next-line no-console
    console.log('\ndemo producer stopped');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
