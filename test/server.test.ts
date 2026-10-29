import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { WebSocket } from 'ws';
import server, { server as namedServer } from '../src/server';

test('runtime entry point exports an unbound server and serves the application', async (t) => {
  assert.equal(server, namedServer);
  assert.equal(server.listening, false, 'importing must not bind a port');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');

  const dashboard = await fetch(base);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /<html/i);
  const script = await fetch(`${base}/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /javascript/);
  await script.text();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/?channel=runtime-test`);
  try {
    const [history] = await once(socket, 'message');
    assert.deepEqual(JSON.parse(history.toString()), { type: 'history', events: [] });
    const message = once(socket, 'message');
    const ingest = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'runtime-test', message: 'runtime works' }),
    });
    assert.equal(ingest.status, 200);
    const event = await ingest.json();
    const [live] = await message;
    assert.deepEqual(JSON.parse(live.toString()), { type: 'event', event });
  } finally {
    const closed = once(socket, 'close');
    socket.close();
    await closed;
  }
});
