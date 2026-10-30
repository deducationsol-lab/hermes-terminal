export const FOLLOW_WALLET = 'omegoMAe1AMY5MFKQQr3JwXVy8F4eCvmBAfcpo8XAfq';
const WSOL = 'So11111111111111111111111111111111111111112';
// Conservative initial coverage. Unknown protocols and ambiguous multi-asset routes skip.
const PROGRAMS = new Set(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4']);
export interface WalletAction { signature: string; address: string; side: 'buy' | 'sell'; timestamp: number; slot: number; }
export interface WalletState { activatedAt: number; through: number; lastRead: number; seen: string[]; queue: WalletAction[]; observed: number; scanned?: number; }
export function classifySwap(tx: any): WalletAction | null {
  if (!tx?.meta || tx.meta.err !== null || !Number.isFinite(tx.blockTime) || !Number.isFinite(tx.slot)) return null;
  const keys = tx.transaction?.message?.accountKeys;
  const signature = tx.transaction?.signatures?.[0];
  if (!Array.isArray(keys) || typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) return null;
  const index = keys.findIndex((k: any) => k.pubkey === FOLLOW_WALLET && k.signer === true);
  if (index < 0) return null;
  const instructions = [...(tx.transaction.message.instructions || []), ...(tx.meta.innerInstructions || []).flatMap((x: any) => x.instructions || [])];
  if (!instructions.some((i: any) => PROGRAMS.has(i.programId))) return null;
  const balances = new Map<string, bigint>();
  try {
    for (const [rows, sign] of [[tx.meta.preTokenBalances, -1n], [tx.meta.postTokenBalances, 1n]] as const) {
      if (!Array.isArray(rows)) return null;
      for (const row of rows) if (row.owner === FOLLOW_WALLET) {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.mint) || !/^\d+$/.test(row.uiTokenAmount?.amount)) return null;
        balances.set(row.mint, (balances.get(row.mint) || 0n) + sign * BigInt(row.uiTokenAmount.amount));
      }
    }
    const assets = [...balances].filter(([mint, delta]) => mint !== WSOL && delta !== 0n);
    if (assets.length !== 1) return null;
    const pre = tx.meta.preBalances?.[index], post = tx.meta.postBalances?.[index];
    if (!Number.isSafeInteger(pre) || !Number.isSafeInteger(post) || !Number.isSafeInteger(tx.meta.fee)) return null;
    const fee = index === 0 ? BigInt(tx.meta.fee) : 0n;
    const sol = BigInt(post) - BigInt(pre) + fee + (balances.get(WSOL) || 0n);
    // Require meaningful counterflow; pure token transfers and fee-only changes skip.
    if (sol > -1000000n && sol < 1000000n) return null;
    const [address, delta] = assets[0];
    if (!(delta > 0n && sol < 0n || delta < 0n && sol > 0n)) return null;
    return { signature, address, side: delta > 0n ? 'buy' : 'sell', timestamp: tx.blockTime * 1000, slot: tx.slot };
  } catch { return null; }
}
export async function pollWallet(state: WalletState, request: typeof fetch = fetch, now = Date.now): Promise<WalletState> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('Helius not configured');
  const end = Math.floor(now() / 1000) - 5;
  const start = Math.max(Math.floor(state.activatedAt / 1000), state.through - 10);
  if (end < start) return state;
  const rows: any[] = []; let paginationToken: string | undefined;
  // Bounded pages, all-or-nothing cursor. Never silently jump over a full backlog.
  for (let page = 0; page < 3; page++) {
    const response = await request('https://mainnet.helius-rpc.com/?api-key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransactionsForAddress', params: [FOLLOW_WALLET, {
        transactionDetails: 'full', encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1,
        sortOrder: 'asc', limit: 100, ...(paginationToken ? { paginationToken } : {}),
        filters: { blockTime: { gte: start, lte: end }, status: 'succeeded', tokenAccounts: 'balanceChanged' }
      }] })
    });
    if (!response.ok) { console.warn('Helius HTTP status', response.status); throw new Error('Helius HTTP unavailable'); }
    const body = await response.json();
    if (body.error || !Array.isArray(body.result?.data)) { console.warn('Helius RPC code', typeof body.error?.code === 'number' ? body.error.code : 'schema'); throw new Error('Helius RPC unavailable'); }
    rows.push(...body.result.data); paginationToken = body.result.paginationToken || undefined;
    if (!paginationToken) break;
    if (page === 2) throw new Error('Helius backlog exceeds bounded page budget');
  }
  const seen = new Set(state.seen); const actions: WalletAction[] = [];
  for (const row of rows) {
    const action = classifySwap(row);
    if (!action || seen.has(action.signature)) continue;
    seen.add(action.signature);
    if (action.timestamp >= state.activatedAt && now() - action.timestamp <= 120000 && action.timestamp <= now()) actions.push(action);
  }
  return { ...state, scanned: (state.scanned || 0) + rows.length, through: end, lastRead: now(), observed: state.observed + actions.length,
    seen: [...seen].slice(-2000), queue: state.queue.concat(actions).filter(a => now() - a.timestamp <= 120000).slice(-200) };
}
