/**
 * HTTP + WebSocket server that wires the LogHub to producers and browser
 * clients.
 *
 * Responsibilities:
 *  - POST /ingest: accept a JSON log event from a producer and publish it.
 *  - GET /healthz: a trivial liveness probe.
 *  - Serve the static terminal dashboard from public/.
 *  - WebSocket: subscribe a client to a single named channel, replay recent
 *    history on connect, then fan out live events.
 *
 * The server is strictly domain-agnostic: it transports arbitrary structured
 * log events and has no knowledge of what they represent.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

import { LogHub } from './hub';
import type { IngestPayload, LogEvent } from './types';

const PORT = Number(process.env.PORT ?? 4000);
const RING_BUFFER_SIZE = Number(process.env.RING_BUFFER_SIZE ?? 500);
/** Channel used when a WebSocket client connects without ?channel=NAME. */
const DEFAULT_CHANNEL = 'default';

// Compiled output lives at dist/src/server.js (tsc preserves the source tree
// because rootDir is the project root), so public/ is two levels up.
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const hub = new LogHub(RING_BUFFER_SIZE);

/**
 * Server -> client WebSocket message protocol.
 *
 * Every message is JSON tagged with a `type` field:
 *  - { type: 'history', events: LogEvent[] } sent once on connect.
 *  - { type: 'event', event: LogEvent } sent for each new live event.
 */
interface HistoryMessage {
  type: 'history';
  events: LogEvent[];
}
interface EventMessage {
  type: 'event';
  event: LogEvent;
}
type ServerMessage = HistoryMessage | EventMessage;

/** Map a file extension to a Content-Type for static serving. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Allow-listed static files served from public/, mapped to request paths. */
const STATIC_FILES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/styles.css': 'styles.css',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Read a request body as a UTF-8 string, capped to a sane limit. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const LIMIT = 1_000_000; // 1 MB
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > LIMIT) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(res: http.ServerResponse, fileName: string): Promise<void> {
  try {
    const filePath = path.join(PUBLIC_DIR, fileName);
    const data = await readFile(filePath);
    const ext = path.extname(fileName);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'content-length': data.length,
    });
    res.end(data);
  } catch {
    sendText(res, 404, 'Not Found');
  }
}

async function handleIngest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid request body' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'invalid JSON' });
    return;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 400, { error: 'body must be a JSON object' });
    return;
  }

  const body = parsed as Record<string, unknown>;
  const channel = body.channel;
  const message = body.message;

  if (typeof channel !== 'string' || channel.length === 0) {
    sendJson(res, 400, { error: 'channel is required' });
    return;
  }
  if (typeof message !== 'string' || message.length === 0) {
    sendJson(res, 400, { error: 'message is required' });
    return;
  }

  const payload: IngestPayload = {
    channel,
    level: typeof body.level === 'string' ? (body.level as string) : 'info',
    message,
    ...(typeof body.meta === 'object' && body.meta !== null
      ? { meta: body.meta as Record<string, unknown> }
      : {}),
    ...(typeof body.ts === 'number' ? { ts: body.ts } : {}),
  };

  const event = hub.publish(payload);
  sendJson(res, 200, event);
}

const server = http.createServer((req, res) => {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  if (method === 'POST' && pathname === '/ingest') {
    void handleIngest(req, res);
    return;
  }

  if (method === 'GET' && pathname === '/healthz') {
    sendText(res, 200, 'ok');
    return;
  }

  if (method === 'GET' && Object.prototype.hasOwnProperty.call(STATIC_FILES, pathname)) {
    void serveStatic(res, STATIC_FILES[pathname]);
    return;
  }

  sendText(res, 404, 'Not Found');
});

const wss = new WebSocketServer({ server });

// Each connection subscribes to exactly one channel (?channel=NAME). A browser
// that renders a multi-panel view (several channels side by side) opens one
// concurrent WebSocket connection per channel rather than multiplexing, so the
// wire protocol stays single-channel and no protocol change is needed.
wss.on('connection', (socket: WebSocket, req: http.IncomingMessage) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const channel = url.searchParams.get('channel') || DEFAULT_CHANNEL;

  const send = (msg: ServerMessage): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  };

  // Replay recent history for this channel on connect.
  send({ type: 'history', events: hub.history(channel) });

  // Subscribe to live events and fan them out to this socket.
  const unsubscribe = hub.subscribe(channel, (event) => {
    send({ type: 'event', event });
  });

  socket.on('close', () => {
    unsubscribe();
  });
  socket.on('error', () => {
    unsubscribe();
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`log streaming server listening on http://localhost:${PORT} (ring buffer size ${RING_BUFFER_SIZE})`);
});

export { server, hub };
