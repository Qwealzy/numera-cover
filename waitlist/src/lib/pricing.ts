// Hero estimator: lookups into the precomputed grid (src/data/grid.json, written by scripts/gen-grid.py with
// the repo's own engine/numera_engine/pricing.py) plus the liquidation helper used to turn a live oracle
// spot into dollar levels. No pricing formula is re-implemented here: every premium comes from the grid.
// Only erasable TypeScript syntax (node --test strips the types).
import grid from '../data/grid.json' with { type: 'json' };

export type Side = 'long' | 'short';
export type Refusal = 'prob_too_high' | 'level_too_close';

export type Setup = { side: Side; lev: number; dur: number; sigma: number; maxLev: number };

export type Estimate = {
  /** Fraction of entry between entry and liquidation (0.0886 = 8.86 %). */
  liqDist: number;
  /** Fraction of entry between entry and the default level (liq + 1 % toward spot). */
  lvlDist: number;
  /** Premium for a $100 payout in USDC base units (6 dec), after the v2 floor; null when refused. */
  premium: number | null;
  /** The v2 floor (0.20 % of payout) raised the model premium. */
  floorApplied: boolean;
  /** Raw model touch probability (GBM, before the tail table). 0 when refused before pricing. */
  p: number;
  refusal: Refusal | null;
};

type SideBlock = { lev: [number, number]; liq: number[]; lvl: number[]; prem: number[]; p: number[]; floor: number[] };
type Grid = {
  meta: Record<string, unknown>;
  payout: number;
  durations: number[];
  sigmas: number[];
  perps: Record<string, Record<Side, SideBlock>>;
};
const G = grid as unknown as Grid;

export const GRID_META = G.meta;
export const GRID_PAYOUT = G.payout;
export const DURATIONS = G.durations;
export const SIGMAS = G.sigmas;
/** Max leverages the grid covers (P0: 40 for BTC; docs/research/hyperliquid.md "1.25% at 40×"). */
export const MAX_LEVS = Object.keys(G.perps).map(Number);

/** Default hero scene (build spec 2.3 fallback): BTC long 10×, 1d, normal volatility. */
export const DEFAULT_SETUP: Setup = { side: 'long', lev: 10, dur: 86400, sigma: 0.4, maxLev: 40 };

export function estimate(s: Setup): Estimate {
  const block = G.perps[String(s.maxLev)]?.[s.side];
  if (!block) throw new Error(`no grid for maxLev ${s.maxLev}`);
  const [lo, hi] = block.lev;
  const lev = Math.round(s.lev);
  if (lev < lo || lev > hi) throw new Error(`leverage ${s.lev} outside ${lo}-${hi}`);
  const li = lev - lo;
  const di = G.durations.indexOf(s.dur);
  const si = G.sigmas.findIndex((x) => Math.abs(x - s.sigma) < 1e-9);
  if (di < 0 || si < 0) throw new Error(`duration ${s.dur} or sigma ${s.sigma} not in the grid`);
  const i = (li * G.durations.length + di) * G.sigmas.length + si;
  const raw = block.prem[i];
  const refusal: Refusal | null = raw === -1 ? 'prob_too_high' : raw === -2 ? 'level_too_close' : null;
  return {
    liqDist: block.liq[li],
    lvlDist: block.lvl[li],
    premium: refusal ? null : raw,
    floorApplied: block.floor[i] === 1,
    p: block.p[i],
    refusal,
  };
}

/** Premium for a $100 payout in dollars, rounded UP to the cent (never shows less than the grid value). */
export function premiumDollars(baseUnits: number): number {
  return Math.ceil(baseUnits / 10_000) / 100;
}

export const fmtUsd = (x: number, digits = 2): string =>
  '$' + x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** "8.86 %" (two decimals, the way the content brief writes distances). */
export const fmtPct = (frac: number, digits = 2): string => `${(frac * 100).toFixed(digits)} %`;

/** Model touch chance for display: "< 0.01 %" below that, otherwise two significant decimals. */
export function fmtProb(p: number): string {
  if (!(p > 0) || p < 0.0001) return '< 0.01 %';
  if (p < 0.01) return `${(p * 100).toFixed(2)} %`;
  return `${(p * 100).toFixed(1)} %`;
}

/**
 * Liquidation price for an isolated position with entry = spot (content brief §4b; app/src/lib/liq.ts):
 *   mm = 1 / (2 maxLev); long: entry (1 - (1/L - mm)/(1 - mm)); short: entry (1 + (1/L - mm)/(1 + mm)).
 * First margin tier only; real cross-margin positions differ.
 */
export function liqPrice(entry: number, lev: number, maxLev: number, side: Side): number {
  const mm = 1 / (2 * maxLev);
  const s = side === 'long' ? 1 : -1;
  const frac = (1 / lev - mm) / (1 - s * mm);
  return entry * (1 - s * frac);
}

/** Default level: 1 % of the liquidation price toward spot (app/src/config.ts LEVEL_BUFFER 0.01). */
export const LEVEL_BUFFER = 0.01;
export function defaultLevel(liq: number, side: Side): number {
  return side === 'long' ? liq * (1 + LEVEL_BUFFER) : liq * (1 - LEVEL_BUFFER);
}

/** px6 (USD × 1e6) -> dollars as a number (display only). */
export const px6ToUsd = (px6: bigint): number => Number(px6) / 1e6;

/** Dollar price with sensible decimals for a perp oracle price. */
export function fmtPrice(usd: number): string {
  const d = usd >= 1000 ? 2 : usd >= 1 ? 3 : 5;
  return fmtUsd(usd, d);
}
