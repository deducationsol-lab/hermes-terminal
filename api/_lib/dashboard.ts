import type { BackgroundState } from './background';
export interface Activity {
  since: number; coverage: string; buys: number; sells: number; buyCost: number; sellProceeds: number; fees: number;
  tokens: Record<string, { bought: number; sold: number; buyCost: number; sells: number; buys: number }>;
}
export function addActivity(activity: Activity | undefined, events: any[], now: number): Activity {
  const a: Activity = activity ? structuredClone(activity) : { since: events[0]?.ts || now,
    coverage: 'Seeded from retained recent logs at dashboard activation; subsequent fills persist. Earlier trimmed fills may be missing.',
    buys: 0, sells: 0, buyCost: 0, sellProceeds: 0, fees: 0, tokens: {} };
  for (const e of events) {
    const m = e.meta;
    const buy = m?.kind === 'simulated-buy';
    const sell = m?.agent === 'executor' && Number.isFinite(m?.remaining) && Number.isFinite(m?.realizedPnl);
    if ((!buy && !sell) || !Number.isFinite(m.quantity) || !Number.isFinite(m.fill) || !Number.isFinite(m.fee)) continue;
    const t = a.tokens[m.address] ||= { bought: 0, sold: 0, buyCost: 0, buys: 0, sells: 0 };
    a.fees += m.fee;
    if (buy) { a.buys++; t.buys++; t.bought += m.quantity; t.buyCost += m.totalCost; a.buyCost += m.totalCost; }
    else { a.sells++; t.sells++; t.sold += m.quantity; a.sellProceeds += m.quantity * m.fill - m.fee; }
  }
  return a;
}
export function dashboard(state: BackgroundState) {
  const a = state.activity || addActivity(undefined, state.events, state.lastAttempt);
  const names: Record<string, string> = { ...state.tokenNames };
  for (const e of state.events) if (e.meta?.address && e.meta?.symbol && e.meta.symbol !== e.meta.address) names[e.meta.address] ||= e.meta.symbol;
  const holdings = Object.entries(state.account.positions).map(([address, p]) => {
    const q = state.account.quotes[address]; const mark = q?.price;
    return { address, symbol: names[address] || null, quantity: p.qty, accumulatedQuantity: Math.max(a.tokens[address]?.bought || 0, p.originalQty),
      accumulationCoverage: 'At least this quantity: max of recorded gross buys and current-position original quantity. ' + a.coverage,
      totalBuyCost: a.tokens[address]?.buyCost ?? null, remainingCost: p.cost, averageEntry: p.entry,
      price: mark ?? null, value: Number.isFinite(mark) ? p.qty * mark : null,
      unrealized: Number.isFinite(mark) ? p.qty * mark - p.cost : null, quoteTime: q?.time || null,
      stale: !q || Date.now() - q.time > 60000, moonbag: p.moonbag,
      buys: a.tokens[address]?.buys ?? null, sells: a.tokens[address]?.sells ?? null };
  });
  const fills = state.events.filter(e => e.meta?.kind === 'simulated-buy' ||
    e.meta?.agent === 'executor' && Number.isFinite(e.meta?.remaining) && Number.isFinite(e.meta?.realizedPnl)).slice(-50).reverse();
  return { holdings, activity: a, fills, source: { scanned: state.wallet?.scanned || 0, swaps: state.wallet?.observed || 0 },
    unrealized: state.snapshot.pnl - state.snapshot.realized };
}
