// Units (ARCHITECTURE §3): px6 = USD × 1e6, USDC = 6 decimals, pool shares = 12 decimals.
// Formatting is exact bigint arithmetic (no float rounding on money).

export const PX_DECIMALS = 6;
export const USDC_DECIMALS = 6;
export const SHARE_DECIMALS = 12;

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Fixed-point bigint → string with `shown` decimals, rounded half away from zero, thousands-grouped. */
export function fmtFixed(value: bigint, decimals: number, shown: number, group = true): string {
  const neg = value < 0n;
  let v = neg ? -value : value;
  if (shown < decimals) {
    const div = 10n ** BigInt(decimals - shown);
    v = (v + div / 2n) / div;
  } else if (shown > decimals) {
    v = v * 10n ** BigInt(shown - decimals);
  }
  const s = v.toString().padStart(shown + 1, '0');
  const intPart = s.slice(0, s.length - shown);
  const frac = shown > 0 ? '.' + s.slice(s.length - shown) : '';
  const out = (group ? groupThousands(intPart) : intPart) + frac;
  return neg && v !== 0n ? '-' + out : out;
}

/** Decimals that make a price readable: 2 for ≥ $1, more for small prices (max 6). */
export function pxDigits(px6: bigint): number {
  const a = px6 < 0n ? -px6 : px6;
  if (a >= 1_000_000n) return 2;
  if (a >= 10_000n) return 4;
  return 6;
}

export const fmtPx6 = (px6: bigint, shown = pxDigits(px6)) => '$' + fmtFixed(px6, PX_DECIMALS, shown);
export const fmtUsdc = (amount: bigint, shown = 2) => fmtFixed(amount, USDC_DECIMALS, shown);
export const fmtShares = (shares: bigint, shown = 4) => fmtFixed(shares, SHARE_DECIMALS, shown);

/** Float USD → px6 bigint, via a decimal string (no binary float drift beyond 6 dp). */
export function usdToPx6(usd: number): bigint {
  if (!Number.isFinite(usd)) throw new Error('not a finite price');
  return parseDecimal(usd.toFixed(PX_DECIMALS), PX_DECIMALS);
}
export const px6ToNumber = (px6: bigint) => Number(px6) / 1e6;
export const usdcToNumber = (amt: bigint) => Number(amt) / 1e6;

/**
 * Parse a user-typed decimal ("1,234.5") into fixed-point units. Throws on garbage, negative numbers or
 * more fractional digits than the unit supports.
 */
export function parseDecimal(input: string, decimals: number): bigint {
  const s = input.trim().replace(/,/g, '').replace(/^\$/, '');
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(s)) throw new Error(`"${input}" is not a positive number`);
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) throw new Error(`at most ${decimals} decimals`);
  return BigInt((i || '0') + f.padEnd(decimals, '0'));
}

/** Basis points → "12.34 %". */
export const fmtBps = (bps: bigint | number, shown = 2) => fmtFixed(BigInt(bps), 2, shown) + ' %';

/** a/b as a percentage string with `shown` decimals; "—" when b = 0. */
export function fmtRatio(a: bigint, b: bigint, shown = 2): string {
  if (b === 0n) return '—';
  return fmtFixed((a * 10n ** BigInt(2 + shown)) / b, shown, shown) + ' %';
}

export const fmtPct = (x: number, shown = 2) => (Number.isFinite(x) ? (x * 100).toFixed(shown) + ' %' : '—');

/** Probability with enough significant digits for tiny tails (e.g. 3.1e-7). */
export function fmtProb(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p === 0) return '0';
  if (p < 1e-4) return p.toExponential(2);
  return (p * 100).toFixed(p < 0.01 ? 4 : 2) + ' %';
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Seconds → "3d 4h", "2h 05m", "45s". Negative → "ended". */
export function fmtDuration(sec: number): string {
  if (sec <= 0) return 'ended';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(Math.floor(sec % 60)).padStart(2, '0')}s`;
  return `${Math.floor(sec)}s`;
}

export function fmtTime(unixSec: number | bigint): string {
  const d = new Date(Number(unixSec) * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
