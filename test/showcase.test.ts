import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

interface DemoEvent { seq: number; channel: string; message: string; meta: { agent: string; mode: string; synthetic: boolean }; }
interface Demo { start(): void; stop(): void; pause(value: boolean): void; }
interface DemoApi { create(options: { channel: string; emit(event: DemoEvent): void; setInterval(callback: () => void, ms: number): number; clearInterval(id: number): void }): Demo; }

test('showcase auto-starts, cycles agents, pauses, resumes and releases its timer without network access', () => {
  const context: { HermesShowcase?: DemoApi } = {};
  // No DOM or network APIs are supplied: generation must be entirely local.
  runInNewContext(readFileSync('public/showcase.js', 'utf8'), context);
  const events: DemoEvent[] = [];
  let tick = () => {};
  let timers = 0;
  let cleared = 0;
  const demo = context.HermesShowcase!.create({
    channel: 'showcase', emit: (event) => events.push(event),
    setInterval: (callback) => { tick = callback; timers += 1; return 7; },
    clearInterval: (id) => { assert.equal(id, 7); cleared += 1; }
  });
  demo.start();
  demo.start();
  assert.equal(timers, 1);
  assert.equal(events.length, 1);
  for (let i = 0; i < 11; i++) tick();
  assert.equal(new Set(events.map((event) => event.meta.agent)).size, 6);
  events.forEach((event, index) => {
    assert.equal(event.seq, index);
    assert.equal(event.channel, 'showcase');
    assert.equal(event.meta.mode, 'simulation');
    assert.equal(event.meta.synthetic, true);
    assert.match(event.message, /^\[SIMULATION\]/);
  });
  demo.pause(true);
  tick();
  assert.equal(events.length, 12);
  demo.pause(false);
  tick();
  assert.equal(events.length, 13);
  demo.stop();
  demo.stop();
  assert.equal(cleared, 1);
});
