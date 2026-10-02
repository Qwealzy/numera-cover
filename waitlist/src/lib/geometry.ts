// Shared geometry of the hero instrument, the wick lanes and the ticket strip. Pure functions: Astro uses them
// at build time for the static SVG fallback, the browser uses the same ones for the canvas, so the two agree.
// Only erasable TypeScript syntax.

export type Side = 'long' | 'short';

/** Distances (fractions of entry) are mapped through a soft log so 2x (~49 %) and 40x (~0.3 %) both fit. */
const D0 = 0.02;
const F_MAX = Math.log(1 + 0.5 / D0);
const soft = (d: number) => Math.log(1 + Math.max(0, d) / D0);

export type Layout = {
  w: number;
  h: number;
  /** +1: lines below the price (long), -1: above (short). */
  dir: 1 | -1;
  headX: number;
  expiryX: number;
  entryY: number;
  levelY: number;
  liqY: number;
  /** Edge of the plot on the liquidation side (the navy zone runs from liqY to here). */
  edgeY: number;
  /** px from entry to the 2x liquidation (the soft map's full scale). */
  span: number;
};

/** `top`: where entry sits, as a fraction of the height from the price side (more headroom on narrow screens). */
export function layout(w: number, h: number, liqDist: number, lvlDist: number, side: Side, top = 0.3): Layout {
  const dir = side === 'long' ? 1 : -1;
  const entryY = side === 'long' ? h * top : h * (1 - top);
  const span = h * (0.84 - top); // entry to the 2x liquidation
  const k = span / F_MAX;
  return {
    w,
    h,
    dir,
    headX: Math.round(w * 0.64),
    expiryX: Math.round(w * 0.9),
    entryY,
    levelY: entryY + dir * k * soft(lvlDist),
    liqY: entryY + dir * k * soft(liqDist),
    edgeY: side === 'long' ? h : 0,
    span,
  };
}

/** Inverse of the soft map: a y on the canvas -> signed distance from entry (fraction; + = toward liq). */
export function distAt(L: Layout, y: number): number {
  const k = L.span / F_MAX;
  const s = ((y - L.entryY) * L.dir) / k;
  return s >= 0 ? D0 * (Math.exp(s) - 1) : -D0 * (Math.exp(-s) - 1);
}

/** Small deterministic PRNG (mulberry32): the static SVG and the first canvas frame draw the same path. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PATH_STEP = 6; // px between history points

/**
 * History of the SIM price path as normalized offsets u (0 = entry, 1 = the level, negative = away from it),
 * one per PATH_STEP px from x = 0 to the head. A mean-reverting walk that never comes near the level, so
 * nothing in it is a touch except the scripted wick (`withWick`).
 */
export function historyU(n: number, seed: number, withWick = false): number[] {
  const r = rng(seed);
  const out: number[] = [];
  let u = -0.05;
  for (let i = 0; i < n; i++) {
    const g = (r() + r() + r() - 1.5) * 0.11;
    u += -0.08 * (u + 0.1) + g;
    u = Math.max(-0.42, Math.min(0.32, u));
    out.push(u);
  }
  if (withWick) {
    // the end frame of the intro: a wick that touched the level ~22 % of the way back from the head
    const c = Math.round(n * 0.78);
    for (let i = 0; i < n; i++) {
      const d = i - c;
      const shape = d <= 0 ? Math.exp(-((d / 3.2) ** 2)) : Math.exp(-((d / 5.5) ** 2));
      out[i] = out[i] * (1 - shape) + 1.0 * shape;
    }
    out[c] = 1;
  }
  return out;
}

/** u -> y for a layout (u = 1 sits exactly on the level). */
export const yOf = (L: Layout, u: number) => L.entryY + u * (L.levelY - L.entryY);

/** SVG path data for the history (x from 0 to the head). */
export function pathD(L: Layout, us: number[]): string {
  const n = us.length;
  const dx = L.headX / Math.max(1, n - 1);
  let d = '';
  for (let i = 0; i < n; i++) d += `${i ? 'L' : 'M'}${(i * dx).toFixed(1)} ${yOf(L, us[i]).toFixed(1)}`;
  return d;
}

/** × tick positions along the liquidation line. */
export function liqTicks(L: Layout, every = 56): number[] {
  const xs: number[] = [];
  for (let x = every / 2; x < L.w; x += every) xs.push(Math.round(x));
  return xs;
}

// ---- the mark (src/assets/numera-mark.svg, viewBox 512) ---------------------------------------------------
export const MARK_GREEN: [number, number][] = [
  [508, 0], [508, 389], [345, 489], [110, 326], [110, 184], [163, 152], [333, 272], [333, 351],
  [180, 244], [180, 296], [346, 412], [441, 354], [443, 116], [389, 148], [330, 108],
];
export const MARK_NAVY: [number, number][] = [
  [164, 24], [397, 184], [397, 331], [347, 362], [333, 352], [333, 221], [162, 101], [67, 160],
  [67, 396], [120, 364], [180, 403], [2, 510], [2, 122],
];

// ---- the scripted wick shared by the three lanes (S2) ------------------------------------------------------
/** Price at time t ∈ [0, 1] in lane units: 0 = start, -1 = the wick's low. Deterministic. */
export function wickAt(t: number): number {
  const base = 0.06 * Math.sin(t * 19) + 0.04 * Math.sin(t * 47 + 1) + 0.25 * t;
  const c = 0.46;
  const d = t - c;
  const dip = d <= 0 ? Math.exp(-((d / 0.03) ** 2)) : Math.exp(-((d / 0.055) ** 2));
  return base * (1 - dip) - 1.0 * dip;
}
export const WICK_LOW_T = 0.46;
/** First time the scripted wick reaches `level` (lane units, negative), or null. */
export function firstCross(level: number, steps = 600): number | null {
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (wickAt(t) <= level) return t;
  }
  return null;
}

/**
 * Tops (px) of the three line labels: entry, level and liquidation. Each sits on the side of its line that
 * faces away from the next line, and labels never overlap (at 40x the three lines are a few px apart).
 */
export function labelTops(entryY: number, levelY: number, liqY: number, dir: 1 | -1, lh = 16): { entry: number; level: number; liq: number } {
  const want =
    dir === 1
      ? { entry: entryY - lh - 2, level: levelY - lh - 2, liq: liqY + 6 }
      : { entry: entryY + 6, level: levelY + 6, liq: liqY - lh - 2 };
  const order = (Object.keys(want) as (keyof typeof want)[]).sort((a, b) => want[a] - want[b]);
  const out = { ...want };
  for (let i = 1; i < order.length; i++) {
    const prev = out[order[i - 1]];
    if (out[order[i]] < prev + lh) out[order[i]] = prev + lh;
  }
  return out;
}
