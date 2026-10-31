export function supabaseConfigured() { return Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)); }
export class SupabaseStore {
  constructor(private request: typeof fetch = fetch) {}
  async rpc(op: string, key: string, value: unknown = null, options: unknown = {}) {
    const base = process.env.SUPABASE_URL;
    const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !secret) throw new Error('Supabase server configuration missing');
    const response = await this.request(base.replace(/\/$/, '') + '/rest/v1/rpc/hermes_storage', {
      method: 'POST', headers: { apikey: secret, Authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
      body: JSON.stringify({ p_op: op, p_key: key, p_value: value, p_options: options }), signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      // Only provider code, never response body/URL/auth headers.
      throw new Error('Supabase RPC unavailable HTTP ' + response.status + ' code ' + (/^[A-Z0-9]{3,12}$/.test(body.code) ? body.code : 'unknown'));
    }
    return response.json();
  }
  async get<T>(key: string): Promise<T | null> { return this.rpc('get', key); }
  async set(key: string, value: string | number, options: { nx?: true; px: number }) { return this.rpc('set', key, value, options); }
  async eval(_script: string, keys: string[], args: string[]) {
    if (keys.length === 1) return this.rpc('release', keys[0], args[0]);
    const events: unknown[] = [];
    for (const group of JSON.parse(args[2])) for (const event of group.events) {
      const archiveKey: string = keys[group.key - 1];
      events.push({ day: archiveKey.slice(-10), event: JSON.parse(event.json) });
    }
    return this.rpc('commit', keys[0], JSON.parse(args[1]), { owner: args[0], stateKey: keys[1], events });
  }
  async zrange(key: string, start: number, end: number): Promise<unknown[]> {
    return this.rpc('history', key.slice(-10), null, { offset: start, limit: end - start + 1 });
  }
}
