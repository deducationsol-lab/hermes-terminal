import assert from 'node:assert/strict';
import test from 'node:test';
import { SupabaseStore } from '../api/_lib/supabase-store';
test('Supabase adapter maps lease, fenced commit and history to service-side RPC without exposing secrets', async () => {
  const old = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co'; process.env.SUPABASE_SECRET_KEY = 'test-placeholder';
  try {
    const calls: any[] = [];
    const db = new SupabaseStore((async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return new Response('1'); }) as typeof fetch);
    await db.set('lock', 'owner', { nx: true, px: 300000 });
    await db.eval('commit', ['lock', 'state', 'hermes:paper:history:v1:2026-10-31'], ['owner', '{"cash":10000}', '[{"key":3,"events":[{"seq":1,"json":"{\\"seq\\":1}"}]}]']);
    assert.equal(calls[0].p_op, 'set'); assert.equal(calls[0].p_options.nx, true);
    assert.deepEqual(calls[1].p_value, { cash: 10000 }); assert.equal(calls[1].p_options.owner, 'owner');
    assert.equal(calls[1].p_options.events[0].day, '2026-10-31');
    await db.zrange('history:2026-10-31', 100, 200); assert.equal(calls[2].p_options.limit, 101);
    const failed = new SupabaseStore((async () => new Response('{"code":"PGRST202","message":"private"}', { status: 404 })) as typeof fetch);
    await assert.rejects(failed.get('state'), /HTTP 404 code PGRST202/);
  } finally {
    if (old === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = old;
    if (key === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = key;
  }
});
