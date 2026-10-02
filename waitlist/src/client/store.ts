// Tiny shared state: the hero setup (read by the readout, the purchase-check cascade and the waitlist door)
// and the live testnet reads. Plain pub/sub, no library.
import { DEFAULT_SETUP, type Setup } from '../lib/pricing.ts';
import type { Ledger } from '../lib/chain.ts';

export type Role = 'trader' | 'underwriter';
export type Live = {
  oraclePx6: bigint | null;
  oracleAt: Date | null;
  oracleState: 'waiting' | 'ok' | 'failed';
  ledger: Ledger | null;
  ledgerAt: Date | null;
};

type State = { setup: Setup; role: Role; live: Live; joined: boolean };

export const state: State = {
  setup: { ...DEFAULT_SETUP },
  role: 'trader',
  live: { oraclePx6: null, oracleAt: null, oracleState: 'waiting', ledger: null, ledgerAt: null },
  joined: false,
};

type Key = keyof State;
const subs: Record<Key, ((s: State) => void)[]> = { setup: [], role: [], live: [], joined: [] };

export function on(key: Key, f: (s: State) => void): void {
  subs[key].push(f);
}
export function set<K extends Key>(key: K, value: State[K]): void {
  state[key] = value;
  for (const f of subs[key]) f(state);
}
export function patchSetup(p: Partial<Setup>): void {
  set('setup', { ...state.setup, ...p });
}
