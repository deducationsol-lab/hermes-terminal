import { publicPayload } from './_lib/public-payload';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { backgroundStore, STATE_KEY, type BackgroundState } from './_lib/background';
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET') { res.statusCode = 405; res.end('{}'); return; }
  try {
    const state = await backgroundStore().get<BackgroundState>(STATE_KEY);
    res.end(JSON.stringify(publicPayload({ enabled: true, intervalSeconds: 30, lastAttempt: state?.lastAttempt || null,
      lastSuccess: state?.lastSuccess || null, status: state?.status || 'Waiting for first production scheduled run',
      policyEpoch: state?.policyEpoch || null, behavior: state?.wallet?.behavior || null, snapshot: state?.snapshot || null, events: state?.events || [] })));
  } catch { res.statusCode = 503; res.end('{"error":"Background state unavailable"}'); }
}
