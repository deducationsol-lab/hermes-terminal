export interface DailyRisk {
  day: string; openingEquity: number; lossLimit: number; paused: boolean;
  pausedAt: number | null; timezone: string;
}
export interface AccountState {
  version: 1; cash: number; realized: number;
  positions: Record<string, { entry: number; originalQty: number; qty: number; cost: number; moonbag: boolean; moonbagPrice?: number; sold5x: boolean; sold10x: boolean }>;
  quotes: Record<string, { price: number; marketCap?: number | null; time: number }>;
  daily?: DailyRisk;
  traded?: Record<string, boolean>;
  excluded: Record<string, boolean>; used: Record<string, boolean>;
}
export function create(emit: (agent: string, kind: string, address: string, message: string, meta: any) => void,
  now: () => number, saved?: AccountState): {
  snapshot(): { daily: DailyRisk & { pnl: number }; cash: number; equity: number; pnl: number; realized: number; positions: AccountState['positions']; staleMarks: string[] };
  exportState(): AccountState;
  holding(address: string): boolean;
  excluded(address: string): boolean;
  update(tokens: { address: string; price: number; marketCap?: number | null }[], timestamp: number): boolean;
  enter(address: string, signal: any): boolean;
};
