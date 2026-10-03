// The three wick lanes of S2 as SVG markup: one scripted wick, one time axis, three defences. Pure: Astro
// renders the end frames at build time and the browser re-renders at the playhead. Scripted, not market data.
import { wickAt, firstCross, WICK_LOW_T } from './geometry.ts';

export type LaneId = 'lev' | 'stop' | 'cover';
export const LANE_EVENTS = {
  stopCross: firstCross(-0.45) ?? 0.44,
  low: WICK_LOW_T,
  coverTouch: firstCross(-0.95) ?? 0.45,
};

const LINES: Record<LaneId, { liq: number; level?: number; stop?: number }> = {
  lev: { liq: -1.75 },
  stop: { liq: -1.16, stop: -0.45 },
  cover: { liq: -1.16, level: -0.95 },
};

const P_TOP = 0.55;
const P_BOT = -2.0;

export type LaneLabels = { liq: string; level: string; stop: string; fill: string; payout: string; small: string; open: string; closed: string };

export function laneSvg(id: LaneId, t: number, w: number, h: number, lb: LaneLabels): string {
  const padL = 8;
  const padR = Math.min(132, w * 0.26); // room for the position block
  const plotW = w - padL - padR;
  const x = (tt: number) => padL + tt * plotW;
  const y = (p: number) => 10 + ((P_TOP - p) / (P_TOP - P_BOT)) * (h - 20);
  const f = (n: number) => n.toFixed(1);
  const L = LINES[id];
  const out: string[] = [];

  // liquidation zone + line
  out.push(`<rect class="ln-zone" x="0" y="${f(y(L.liq))}" width="${f(padL + plotW)}" height="${f(h - y(L.liq))}"/>`);
  out.push(`<line class="ln-liq" x1="0" x2="${f(padL + plotW)}" y1="${f(y(L.liq))}" y2="${f(y(L.liq))}"/>`);
  out.push(`<text class="ln-t" x="${f(padL + 4)}" y="${f(y(L.liq) + 13)}">${lb.liq}</text>`);
  if (L.stop !== undefined) {
    out.push(`<line class="ln-stop" x1="0" x2="${f(padL + plotW)}" y1="${f(y(L.stop))}" y2="${f(y(L.stop))}"/>`);
    out.push(`<text class="ln-t" x="${f(padL + 4)}" y="${f(y(L.stop) - 5)}">${lb.stop}</text>`);
  }
  if (L.level !== undefined) {
    out.push(`<line class="ln-level" x1="0" x2="${f(padL + plotW)}" y1="${f(y(L.level))}" y2="${f(y(L.level))}"/>`);
    out.push(`<text class="ln-t ln-t-green" x="${f(padL + 4)}" y="${f(y(L.level) - 5)}">${lb.level}</text>`);
  }

  // the price path up to the playhead; after a stop fill the rest is a ghost (the price came back without you)
  const N = 160;
  const tEnd = Math.max(0, Math.min(1, t));
  const stopped = id === 'stop' && tEnd >= LANE_EVENTS.low;
  let d = '';
  let ghost = '';
  for (let i = 0; i <= N; i++) {
    const tt = (i / N) * tEnd;
    const pt = `${f(x(tt))} ${f(y(wickAt(tt)))}`;
    if (id === 'stop' && tt > LANE_EVENTS.low) ghost += `${ghost ? 'L' : 'M'}${pt}`;
    if (!(id === 'stop' && tt > LANE_EVENTS.low)) d += `${d ? 'L' : 'M'}${pt}`;
  }
  if (stopped) ghost = `M${f(x(LANE_EVENTS.low))} ${f(y(wickAt(LANE_EVENTS.low)))}` + ghost.replace(/^M/, 'L');
  out.push(`<path class="ln-price" d="${d}"/>`);
  if (ghost) out.push(`<path class="ln-ghost" d="${ghost}"/>`);
  out.push(`<line class="ln-head" x1="${f(x(tEnd))}" x2="${f(x(tEnd))}" y1="0" y2="${h}"/>`);

  // events
  if (id === 'stop' && tEnd >= LANE_EVENTS.low) {
    const fx = x(LANE_EVENTS.low);
    const fy = y(wickAt(LANE_EVENTS.low));
    out.push(`<rect class="ln-fill" x="${f(fx - 5)}" y="${f(fy - 5)}" width="10" height="10"/>`);
    out.push(`<text class="ln-t ln-t-strong" x="${f(fx + 10)}" y="${f(fy + 4)}">${lb.fill}</text>`);
  }
  if (id === 'cover' && tEnd >= LANE_EVENTS.coverTouch) {
    const tx = x(LANE_EVENTS.coverTouch);
    const ty = y(L.level!);
    out.push(`<circle class="ln-touch" cx="${f(tx)}" cy="${f(ty)}" r="7"/>`);
    const k = Math.min(1, (tEnd - LANE_EVENTS.coverTouch) / 0.08);
    const cy = ty - 14 - k * 18;
    out.push(`<g class="ln-chip" opacity="${k.toFixed(2)}"><rect x="${f(tx + 10)}" y="${f(cy - 11)}" width="64" height="18" rx="9"/><text x="${f(tx + 42)}" y="${f(cy + 2)}">${lb.payout}</text></g>`);
  }

  // position block on the right: size and state
  const bx = padL + plotW + 18;
  const bw = padR - 26;
  const full = id === 'lev' ? 0.42 : 1;
  const closed = id === 'stop' && tEnd >= LANE_EVENTS.low;
  const bh = 16;
  const by = h / 2 - bh / 2;
  out.push(`<rect class="ln-pos-frame${closed ? ' closed' : ''}" x="${f(bx)}" y="${f(by)}" width="${f(bw)}" height="${bh}" rx="3"/>`);
  if (!closed) out.push(`<rect class="ln-pos" x="${f(bx)}" y="${f(by)}" width="${f(bw * full)}" height="${bh}" rx="3"/>`);
  const label = closed ? lb.closed : id === 'lev' ? lb.small : lb.open;
  out.push(`<text class="ln-t ln-t-strong" text-anchor="end" x="${f(bx + bw)}" y="${f(by - 7)}">${label}</text>`);
  return out.join('');
}
