import { FOLLOW_WALLET } from './helius';
export const PUBLIC_STRATEGY = 'Omniverse · Token Flipper';
// Mask at the API boundary so ticker, expanded details, history and exports
// receive the same redacted view. Internal account/archive records are unchanged.
export function publicPayload<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).split(FOLLOW_WALLET).join(PUBLIC_STRATEGY)
    .split('omego…XAfq').join(PUBLIC_STRATEGY));
}
