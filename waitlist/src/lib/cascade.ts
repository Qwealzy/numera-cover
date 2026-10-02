// The v2 purchase checks in contract order (docs/how-it-works.md §5.3, ARCHITECTURE §5.3), run against the
// visitor's hero setup. Checks that need the buyer's wallet or the pool's live state are shown as "checked on
// chain at purchase", never as passed. Values are the testnet settings in deployments/testnet-v2.json limits.
import { how } from '../copy/en.ts';
import type { Estimate, Setup } from './pricing.ts';

export type CheckState = 'pass' | 'fail' | 'chain' | 'skip';
export type CheckRow = { id: string; text: string; state: CheckState; stateText: string };
export type Cascade = { engineRefused: boolean; rows: CheckRow[]; stopped: boolean };

const C = how.checks;
const S = how.station.buy;
const ORDER: { id: keyof typeof C; kind: 'pass' | 'chain' | 'distance' }[] = [
  { id: 'sig', kind: 'chain' },
  { id: 'perp', kind: 'pass' },
  { id: 'duration', kind: 'pass' },
  { id: 'payout', kind: 'pass' },
  { id: 'premium', kind: 'pass' },
  { id: 'spot', kind: 'chain' },
  { id: 'breached', kind: 'pass' },
  { id: 'distance', kind: 'distance' },
  { id: 'position', kind: 'chain' },
  { id: 'capacity', kind: 'chain' },
  { id: 'throttle', kind: 'chain' },
];

export function cascadeFull(s: Setup, e: Estimate): Cascade {
  void s;
  const engineRefused = e.refusal === 'prob_too_high';
  let stopped = engineRefused;
  const rows = ORDER.map(({ id, kind }): CheckRow => {
    const text = C[id];
    if (stopped) return { id, text, state: 'skip', stateText: '—' };
    if (kind === 'chain') return { id, text, state: 'chain', stateText: S.chain };
    if (kind === 'distance' && e.refusal === 'level_too_close') {
      stopped = true;
      return { id, text, state: 'fail', stateText: S.fail };
    }
    return { id, text, state: 'pass', stateText: S.pass };
  });
  return { engineRefused, rows, stopped };
}

/** Rows only (build-time render). */
export function cascade(s: Setup, e: Estimate): CheckRow[] {
  return cascadeFull(s, e).rows;
}
