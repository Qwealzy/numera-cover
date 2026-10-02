// The hero instrument (build spec 2.3, 2.4): a Canvas2D chart of a SIM price path against the position's
// liquidation line and the cover's level. The visitor can pull the price head (pointer or keyboard) and see
// what cover does on a touch. The canvas is aria-hidden; every meaning is also in DOM text.
import { estimate, fmtPct, fmtPrice, liqPrice, defaultLevel, px6ToUsd, type Estimate } from '../lib/pricing.ts';
import { layout, historyU, liqTicks, distAt, labelTops, MARK_GREEN, MARK_NAVY, PATH_STEP, type Layout } from '../lib/geometry.ts';
import { instrument as I } from '../copy/en.ts';
import { loop, motionOn, onMotion, setMotion, clamp, lerp, expoOut, easeIn, smooth, spring } from './motion.ts';
import { state, on } from './store.ts';

const C = {
  paper: '248,242,239',
  green: '35,183,121',
  navy: '67,92,122',
  navyDeep: '34,55,78',
  ground: '12,21,32',
};
const rgba = (c: string, a: number) => `rgba(${c},${a})`;
const SEED = 20261002;
const SCROLL_PX_S = 52; // history scroll speed
const INTRO_S = 4.4;

type Mode = 'intro' | 'idle' | 'pull' | 'release';

export function mountInstrument(root: HTMLElement): void {
  const stage = root.querySelector<HTMLElement>('[data-stage]')!;
  const canvas = stage.querySelector<HTMLCanvasElement>('canvas')!;
  const svg = stage.querySelector<SVGElement>('.fallback')!;
  const handle = stage.querySelector<HTMLElement>('[data-handle]')!;
  const verdict = root.querySelector<HTMLElement>('[data-verdict]')!;
  const wallet = stage.querySelector<HTMLElement>('[data-wallet]')!;
  const walletValue = stage.querySelector<HTMLElement>('[data-wallet-value]')!;
  const stamp = stage.querySelector<HTMLElement>('[data-stamp]')!;
  const chip = stage.querySelector<HTMLElement>('[data-chip]')!;
  const pullHint = stage.querySelector<HTMLElement>('[data-pull-hint]');
  const position = stage.querySelector<HTMLElement>('[data-position]')!;
  const positionText = stage.querySelector<HTMLElement>('[data-position-text]')!;
  const positionFill = stage.querySelector<HTMLElement>('[data-position-fill]')!;
  const lbl = (k: string) => stage.querySelector<HTMLElement>(`[data-lbl="${k}"]`)!;
  const levelVal = stage.querySelector<HTMLElement>('[data-level-val]')!;
  const liqVal = stage.querySelector<HTMLElement>('[data-liq-val]')!;
  const entryPx = stage.querySelector<HTMLElement>('[data-entry-px]')!;
  const levelPx = stage.querySelector<HTMLElement>('[data-level-px]')!;
  const liqPx = stage.querySelector<HTMLElement>('[data-liq-px]')!;
  const expiryVal = stage.querySelector<HTMLElement>('[data-expiry-val]')!;
  const liveTag = stage.querySelector<HTMLElement>('[data-live-tag]')!;
  const pauseBtn = root.querySelector<HTMLButtonElement>('[data-pause]')!;
  const replayBtn = root.querySelector<HTMLButtonElement>('[data-replay]')!;

  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }

  // ---- geometry state -------------------------------------------------------------------------------
  let w = 0;
  let h = 0;
  let dpr = 1;
  let est: Estimate = estimate(state.setup);
  let L: Layout = layout(1000, 560, est.liqDist, est.lvlDist, state.setup.side);
  // animated line positions as fractions of h (glide on setup changes)
  const glide = { from: { e: 0, l: 0, q: 0 }, to: { e: 0, l: 0, q: 0 }, t0: -1 };
  let fr = { e: L.entryY / L.h, l: L.levelY / L.h, q: L.liqY / L.h };
  glide.to = { ...fr };

  // ---- path state -------------------------------------------------------------------------------------
  let hist: number[] = [];
  let marks: number[] = []; // history indices of recorded touches
  let scrollAcc = 0;
  let baseU = -0.05; // OU head
  const rand = (() => {
    let a = SEED ^ 0x9e3779b9;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();

  let mode: Mode = 'idle';
  let introT = 0;
  let introStart = 0;
  let pullU = 0;
  const rel = { x: 0, v: 0 };
  let touched = false;
  let beyondLiq = false;
  let detentUntil = 0;
  let levelThick = 3;
  let levelThickTarget = 3;
  let lean = { x: 0, y: 0 };
  let leanTarget = { x: 0, y: 0 };
  let lastInput = performance.now();
  let beatT = 0;
  let pulseT = -1; // keeper pulse after a touch (seconds since)
  let pulseAt = { x: 0, y: 0 };
  const chipFly = { t: -1, from: { x: 0, y: 0 }, to: { x: 0, y: 0 } };
  let seqTimers: number[] = [];
  let keyTimer = 0;
  let positionFillV = 1;
  let pulledOnce = false;
  const hint = (on: boolean) => {
    if (pullHint) pullHint.dataset.off = on && !pulledOnce ? '0' : '1';
  };

  const nHist = () => Math.max(8, Math.ceil(L.headX / PATH_STEP) + 2);
  function resetHistory(withWick: boolean) {
    hist = historyU(nHist(), SEED, withWick);
    marks = withWick ? [Math.round(hist.length * 0.78)] : [];
    baseU = hist[hist.length - 1];
    scrollAcc = 0;
  }

  const yAt = (u: number) => fr.e * h + u * (fr.l * h - fr.e * h);
  const uAt = (y: number) => {
    const d = fr.l * h - fr.e * h;
    return Math.abs(d) < 1e-6 ? 0 : (y - fr.e * h) / d;
  };
  const uLiq = () => uAt(fr.q * h);

  function headU(): number {
    if (mode === 'pull') return pullU;
    if (mode === 'release') return rel.x;
    if (mode === 'intro') return introHeadU(introT);
    return baseU + idleDrift();
  }
  function idleDrift(): number {
    const idle = performance.now() - lastInput > 2500;
    if (!idle || !motionOn()) return 0;
    const t = performance.now() / 1000;
    return 0.035 * Math.sin(t * 1.9) + 0.02 * Math.sin(t * 0.61 + 1) + 0.015 * Math.sin(t * 2.7 + 2);
  }
  // intro wick: dive 2.10-2.72 s to the level (u = 1), hold 80 ms, recover with a critically damped return
  function introHeadU(t: number): number {
    if (t < 2.1) return baseU;
    if (t < 2.72) return lerp(baseU, 1, easeIn((t - 2.1) / 0.62));
    if (t < 2.8) return 1;
    const tau = t - 2.8;
    return baseU + (1 - baseU) * Math.exp(-5.5 * tau) * (1 + 5.5 * tau);
  }

  // ---- layout / sizing ----------------------------------------------------------------------------------
  const topFrac = () => (w > 0 && w < 640 ? 0.4 : 0.3); // narrow stages: room for the tags above the price
  function target() {
    est = estimate(state.setup);
    const T = layout(1000, 1000, est.liqDist, est.lvlDist, state.setup.side, topFrac());
    return { e: T.entryY / 1000, l: T.levelY / 1000, q: T.liqY / 1000 };
  }
  function relayout(animate: boolean) {
    const to = target();
    if (animate && motionOn()) {
      glide.from = { ...fr };
      glide.to = to;
      glide.t0 = performance.now();
      run.start();
    } else {
      fr = to;
      glide.to = to;
      glide.t0 = -1;
    }
    L = layout(w || 1000, h || 560, est.liqDist, est.lvlDist, state.setup.side, topFrac());
    stage.dataset.dir = String(L.dir);
    labels();
    hud();
    paintStatic();
  }
  function size() {
    const r = stage.getBoundingClientRect();
    w = Math.max(1, Math.round(r.width));
    h = Math.max(1, Math.round(r.height));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    L = layout(w, h, est.liqDist, est.lvlDist, state.setup.side, topFrac());
    const t = target();
    if (glide.t0 < 0) fr = t;
    glide.to = t;
    const n = nHist();
    if (hist.length < n) {
      const extra = historyU(n - hist.length, SEED + n, false);
      hist = extra.concat(hist);
      marks = marks.map((m) => m + extra.length);
    } else if (hist.length > n) {
      const cut = hist.length - n;
      hist = hist.slice(cut);
      marks = marks.map((m) => m - cut).filter((m) => m >= 0);
    }
  }

  // ---- DOM labels -------------------------------------------------------------------------------------------
  const setXY = (el: HTMLElement, xPct: number, yPct: number) => {
    el.style.setProperty('--x', xPct.toFixed(3));
    el.style.setProperty('--y', yPct.toFixed(3));
  };
  function labels() {
    const side = state.setup.side;
    const sign = side === 'long' ? '−' : '+';
    const px = state.live.oraclePx6;
    levelVal.textContent = `${sign}${fmtPct(est.lvlDist)}`;
    liqVal.textContent = `${sign}${fmtPct(est.liqDist)}`;
    if (px !== null) {
      const entry = px6ToUsd(px);
      const liq = liqPrice(entry, state.setup.lev, state.setup.maxLev, side);
      levelPx.textContent = ` · ${fmtPrice(defaultLevel(liq, side))}`;
      liqPx.textContent = ` · ${fmtPrice(liq)}`;
      entryPx.textContent = ` · ${fmtPrice(entry)}`;
    } else entryPx.textContent = levelPx.textContent = liqPx.textContent = '';
    const dl = { 3600: '1h', 14400: '4h', 86400: '1d', 259200: '3d', 604800: '7d' } as Record<number, string>;
    expiryVal.textContent = dl[state.setup.dur] ?? '';
  }
  function placeLabels() {
    const hh = h || 560;
    const t = labelTops(fr.e * hh, fr.l * hh, fr.q * hh, L.dir, 16);
    const x = (L.expiryX / L.w) * 100;
    setXY(lbl('entry'), x, (t.entry / hh) * 100);
    setXY(lbl('level'), x, (t.level / hh) * 100);
    setXY(lbl('liq'), x, (t.liq / hh) * 100);
    setXY(lbl('expiry'), (L.expiryX / L.w) * 100, 100);
  }

  function liveTagText() {
    const s = state.live;
    liveTag.dataset.state = s.oracleState;
    if (s.oracleState === 'ok' && s.oraclePx6 !== null && s.oracleAt)
      liveTag.textContent = `${I.livePrefix} ${s.oracleAt.toISOString().slice(11, 19)} UTC`;
    else if (s.oracleState === 'failed') liveTag.textContent = I.liveFailed;
    else liveTag.textContent = I.liveWaiting;
  }

  // ---- HUD state (stamp, wallet, position) ------------------------------------------------------------
  let payouts = 1;
  let posOpen = true;
  function hud() {
    wallet.dataset.paid = payouts > 0 ? '1' : '0';
    walletValue.textContent = payouts > 0 ? I.walletPaid.replace('$100', `$${100 * payouts}`) : I.walletEmpty;
    position.dataset.state = posOpen ? 'open' : 'closed';
    positionText.textContent = posOpen ? I.positionOpen : I.positionClosed;
    positionFill.style.setProperty('--fill', String(posOpen ? positionFillV : 0));
  }
  function bump(el: HTMLElement) {
    el.classList.remove('bump');
    if (!motionOn()) return;
    void el.offsetWidth;
    el.classList.add('bump');
  }
  function stampImpact() {
    stamp.dataset.on = '1';
    if (!motionOn()) return;
    stamp.animate(
      [
        { scale: '1.35', opacity: 0 },
        { scale: '1', opacity: 1, offset: 0.55 },
        { translate: '0 3px', offset: 0.75 },
        { translate: '0 0', scale: '1', opacity: 1 },
      ],
      { duration: 300, easing: 'ease-in' },
    );
  }

  // ---- drawing --------------------------------------------------------------------------------------------
  function headPos(): { x: number; y: number } {
    const u = headU();
    let y = yAt(u);
    if (mode === 'pull' && performance.now() < detentUntil) y = yAt(1) + L.dir * 2;
    return { x: L.headX + lean.x, y: y + lean.y };
  }

  function draw(now: number) {
    if (!ctx) return;
    const c = ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const eY = fr.e * h;
    const lY = fr.l * h;
    const qY = fr.q * h;
    const dir = L.dir;
    const morph = mode === 'intro' ? clamp(introT / 1.4, 0, 1) : 1;
    const linesA = mode === 'intro' ? clamp((introT - 0.85) / 0.55, 0, 1) : 1;

    // time grid: faint verticals that scroll with the history
    c.strokeStyle = rgba(C.paper, 0.045);
    c.lineWidth = 1;
    c.beginPath();
    for (let x = L.headX - scrollAcc; x > 0; x -= PATH_STEP * 12) {
      c.moveTo(Math.round(x) + 0.5, 0);
      c.lineTo(Math.round(x) + 0.5, h);
    }
    c.stroke();

    c.globalAlpha = linesA;
    // liquidation zone
    c.fillStyle = rgba(C.navy, 0.3);
    if (dir === 1) c.fillRect(0, qY, w, h - qY);
    else c.fillRect(0, 0, w, qY);
    // expiry
    c.setLineDash([2, 6]);
    c.strokeStyle = rgba(C.paper, 0.2);
    c.beginPath();
    c.moveTo(L.expiryX + 0.5, 0);
    c.lineTo(L.expiryX + 0.5, h);
    c.stroke();
    // entry hairline
    c.setLineDash([]);
    c.strokeStyle = rgba(C.paper, 0.22);
    c.beginPath();
    c.moveTo(0, Math.round(eY) + 0.5);
    c.lineTo(w, Math.round(eY) + 0.5);
    c.stroke();
    // liquidation: dashed paper line with × ticks
    c.setLineDash([7, 6]);
    c.strokeStyle = rgba(C.paper, 0.8);
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(0, qY);
    c.lineTo(w, qY);
    c.stroke();
    c.setLineDash([]);
    c.beginPath();
    for (const x of liqTicks(L, 56)) {
      c.moveTo(x - 4, qY - 4);
      c.lineTo(x + 4, qY + 4);
      c.moveTo(x + 4, qY - 4);
      c.lineTo(x - 4, qY + 4);
    }
    c.stroke();
    // level
    c.strokeStyle = rgba(C.green, 1);
    c.lineWidth = levelThick;
    c.beginPath();
    c.moveTo(0, lY);
    c.lineTo(w, lY);
    c.stroke();
    c.globalAlpha = 1;

    // price path (+ the string bend toward the head)
    const reveal = mode === 'intro' ? expoOut(clamp((introT - 1.15) / 0.85, 0, 1)) : 1;
    if (reveal > 0) {
      const hp = headPos();
      const n = hist.length;
      const lastX = L.headX - scrollAcc;
      const endU = hist[n - 1];
      const hu = uAt(hp.y - lean.y);
      const bendN = 9;
      c.save();
      c.beginPath();
      c.rect(0, 0, reveal * (L.headX + 40), h);
      c.clip();
      c.strokeStyle = rgba(C.paper, 0.96);
      c.lineWidth = 2;
      c.lineJoin = 'round';
      c.beginPath();
      for (let i = 0; i < n; i++) {
        const x = lastX - (n - 1 - i) * PATH_STEP;
        let u = hist[i];
        const k = i - (n - 1 - bendN);
        if (k > 0) u += (hu - endU) * smooth(k / bendN) * 0.92;
        const y = yAt(u);
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.lineTo(hp.x, hp.y);
      c.stroke();
      c.restore();

      // touch marks recorded in the history
      c.strokeStyle = rgba(C.green, 1);
      c.lineWidth = 2;
      for (const m of marks) {
        const x = lastX - (n - 1 - m) * PATH_STEP;
        if (x < -10) continue;
        c.beginPath();
        c.arc(x, lY, 7, 0, Math.PI * 2);
        c.stroke();
      }

      if (reveal >= 0.98) {
        // keeper heartbeat: every 3 s, every 1 s near the level (build spec 2.4 #5)
        const near = Math.abs(distAt(L, hp.y) - est.lvlDist) < 0.01 || Math.abs(hu - 1) < 0.15;
        const period = near ? 1 : 3;
        const bt = (beatT % period) / 0.9;
        if (bt < 1 && motionOn()) {
          c.strokeStyle = rgba(C.green, 0.45 * (1 - bt));
          c.lineWidth = 1.5;
          c.beginPath();
          c.arc(hp.x, hp.y, 8 + 22 * expoOut(bt), 0, Math.PI * 2);
          c.stroke();
        }
        // head
        c.fillStyle = rgba(C.paper, 1);
        c.beginPath();
        c.arc(hp.x, hp.y, 6, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = rgba(C.paper, 0.25);
        c.lineWidth = 4;
        c.beginPath();
        c.arc(hp.x, hp.y, 10, 0, Math.PI * 2);
        c.stroke();
        const hx = ((hp.x / w) * 100).toFixed(3);
        const hy = ((hp.y / h) * 100).toFixed(3);
        handle.style.setProperty('--x', hx);
        handle.style.setProperty('--y', hy);
        if (pullHint) {
          pullHint.style.setProperty('--x', hx);
          pullHint.style.setProperty('--y', hy);
        }
      }
    }

    // keeper pulse after a touch: a fast green ring
    if (pulseT >= 0 && pulseT < 0.28) {
      const k = pulseT / 0.28;
      c.strokeStyle = rgba(C.green, 0.9 * (1 - k));
      c.lineWidth = 2.5;
      c.beginPath();
      c.arc(pulseAt.x, pulseAt.y, 6 + 34 * expoOut(k), 0, Math.PI * 2);
      c.stroke();
    }

    // intro: the mark's two polygons part and flatten into the liquidation line and the level
    if (mode === 'intro' && morph < 1) drawMorph(c, morph, qY, lY);
    void now;
  }

  const rankX = (pts: [number, number][]) => {
    const order = pts.map((p, i) => [p[0], i] as const).sort((a, b) => a[0] - b[0]);
    const r: number[] = [];
    order.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const RG = rankX(MARK_GREEN);
  const RN = rankX(MARK_NAVY);
  function drawMorph(c: CanvasRenderingContext2D, t: number, qY: number, lY: number) {
    const s = (h * 0.5) / 512;
    const cx = w * 0.5;
    const cy = h * 0.47;
    const part = expoOut(clamp(t / 0.25, 0, 1)) * 14;
    const flat = clamp((t - 0.18) / 0.82, 0, 1);
    const poly = (pts: [number, number][], rank: number[], ty: number, dx: number, dy: number, col: string) => {
      const n = pts.length;
      c.beginPath();
      pts.forEach((p, i) => {
        const f = expoOut(clamp(flat * 1.25 - (rank[i] / n) * 0.25, 0, 1));
        const sx = cx + (p[0] - 256) * s + dx;
        const sy = cy + (p[1] - 256) * s + dy;
        const tx = lerp(w * 0.04, w * 0.96, rank[i] / (n - 1));
        const x = lerp(sx, tx, f);
        const y = lerp(sy, ty, f);
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      });
      c.closePath();
      c.fillStyle = col;
      c.globalAlpha = 1 - smooth(clamp((t - 0.7) / 0.3, 0, 1));
      c.fill();
      c.globalAlpha = 1;
    };
    poly(MARK_NAVY, RN, qY, -part, part * 0.6, '#435c7a');
    poly(MARK_GREEN, RG, lY, part, -part * 0.6, '#23b779');
  }

  // ---- the frame loop -----------------------------------------------------------------------------------------
  function step(dt: number, now: number) {
    // glide
    if (glide.t0 >= 0) {
      const k = expoOut(clamp((now - glide.t0) / 240, 0, 1));
      fr = {
        e: lerp(glide.from.e, glide.to.e, k),
        l: lerp(glide.from.l, glide.to.l, k),
        q: lerp(glide.from.q, glide.to.q, k),
      };
      if (k >= 1) glide.t0 = -1;
      placeLabels();
    }
    // OU head
    const g = (rand() + rand() + rand() - 1.5) * 1.15;
    baseU += -0.9 * (baseU + 0.08) * dt + g * Math.sqrt(dt) * 0.42;
    baseU = clamp(baseU, -0.45, 0.35);
    // history scroll records the drawn head (so wicks the visitor pulls stay on the chart)
    scrollAcc += SCROLL_PX_S * dt;
    while (scrollAcc >= PATH_STEP) {
      scrollAcc -= PATH_STEP;
      hist.shift();
      hist.push(headU());
      marks = marks.map((m) => m - 1).filter((m) => m > -4);
    }
    beatT += dt;
    if (pulseT >= 0) pulseT += dt;
    if (pulseT > 0.4) pulseT = -1;
    levelThick += (levelThickTarget - levelThick) * Math.min(1, dt * 14);
    lean.x += (leanTarget.x - lean.x) * 0.12;
    lean.y += (leanTarget.y - lean.y) * 0.12;

    if (mode === 'intro') {
      // wall-clock time: the intro ends on time even when frames are slow or dropped
      const prev = introT;
      introT = (now - introStart) / 1000;
      introEvents(prev, introT);
      if (introT >= INTRO_S) {
        mode = 'idle';
        hint(true);
      }
    } else if (mode === 'release') {
      spring(rel, baseU, dt, 190, 17);
      if (Math.abs(rel.x - baseU) < 0.004 && Math.abs(rel.v) < 0.02) mode = 'idle';
    }
    if (chipFly.t >= 0) flyChip(dt);
    // the stamp follows the last touch mark as it scrolls away
    if (marks.length) {
      const m = marks[marks.length - 1];
      const x = L.headX - scrollAcc - (hist.length - 1 - m) * PATH_STEP;
      stamp.style.setProperty('--x', ((x / w) * 100).toFixed(3));
      stamp.style.setProperty('--y', (fr.l * 100).toFixed(3));
      if (x < 30 && stamp.dataset.on === '1') stamp.dataset.on = '0';
    }
    draw(now);
    return true;
  }
  const run = loop('hero', stage, step);

  function introEvents(a: number, b: number) {
    const at = (t: number) => a < t && b >= t;
    if (at(2.72)) {
      levelThickTarget = 5;
      const hp = { x: L.headX, y: yAt(1) };
      pulseAt = hp;
      pulseT = 0;
      marks.push(hist.length - 1);
    }
    if (at(2.95)) {
      levelThickTarget = 3;
      stampImpact();
    }
    if (at(3.08)) launchChip({ x: L.headX, y: yAt(1) });
    if (at(3.6)) verdict.textContent = I.introVerdict;
  }

  function launchChip(from: { x: number; y: number }) {
    if (!motionOn()) {
      payouts++;
      hud();
      return;
    }
    const sr = stage.getBoundingClientRect();
    const wr = wallet.getBoundingClientRect();
    chipFly.from = { x: from.x - 40, y: from.y - 34 };
    chipFly.to = { x: wr.left - sr.left + 8, y: wr.top - sr.top + wr.height / 2 - 12 };
    chipFly.t = 0;
    chip.style.opacity = '1';
  }
  function flyChip(dt: number) {
    chipFly.t += dt / 0.48;
    const k = expoOut(clamp(chipFly.t, 0, 1));
    const x = lerp(chipFly.from.x, chipFly.to.x, k);
    const y = lerp(chipFly.from.y, chipFly.to.y, k) - Math.sin(k * Math.PI) * 26;
    chip.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${lerp(1, 0.86, k).toFixed(3)})`;
    if (chipFly.t >= 1) {
      chipFly.t = -1;
      chip.style.opacity = '0';
      payouts++;
      hud();
      bump(wallet);
    }
  }

  // ---- static paint (motion off, or a frame while the loop is not running) -----------------------------------
  function paintStatic() {
    placeLabels();
    if (!ctx) return;
    if (!run.active) draw(performance.now());
  }

  // ---- intro / replay / end frame ---------------------------------------------------------------------------
  function clearSeq() {
    seqTimers.forEach((t) => clearTimeout(t));
    seqTimers = [];
  }
  function endFrame() {
    clearSeq();
    mode = 'idle';
    resetHistory(true);
    fr = target();
    glide.t0 = -1;
    payouts = 1;
    posOpen = true;
    positionFillV = 1;
    levelThick = levelThickTarget = 3;
    stamp.dataset.on = '1';
    chip.style.opacity = '0';
    chipFly.t = -1;
    verdict.textContent = I.introVerdict;
    hint(true);
    hud();
    paintStatic();
  }
  function startIntro() {
    if (!ctx || !motionOn()) {
      endFrame();
      return;
    }
    clearSeq();
    resetHistory(false);
    fr = target();
    glide.t0 = -1;
    mode = 'intro';
    introT = 0;
    introStart = performance.now();
    hint(false);
    payouts = 0;
    posOpen = true;
    positionFillV = 1;
    stamp.dataset.on = '0';
    hud();
    placeLabels();
    run.start();
  }

  // ---- pull the wick -------------------------------------------------------------------------------------
  function beginPull() {
    pulledOnce = true;
    hint(false);
    if (mode === 'intro') endIntroNow();
    clearSeq();
    mode = 'pull';
    pullU = headU();
    touched = false;
    beyondLiq = false;
    posOpen = true;
    positionFillV = 1;
    hud();
    lastInput = performance.now();
    run.start();
  }
  function endIntroNow() {
    introT = INTRO_S;
    mode = 'idle';
    hint(true);
    payouts = Math.max(1, payouts);
    hud();
    stamp.dataset.on = marks.length ? '1' : '0';
  }
  function movePull(u: number) {
    const before = pullU;
    const uq = uLiq();
    const lim = Math.max(uq * 1.25, uq + 0.2);
    pullU = clamp(u, -1.6, lim);
    // detent when crossing the level
    if ((before - 1) * (pullU - 1) < 0 || (before < 1 && pullU >= 1)) {
      if (!touched || (before - 1) * (pullU - 1) < 0) {
        detentUntil = performance.now() + 80;
        levelThickTarget = 5;
        if (!motionOn()) levelThick = 5;
      }
    }
    if (pullU >= 1) touched = true;
    if (pullU < 1) {
      levelThickTarget = 3;
      if (!motionOn()) levelThick = 3;
    }
    beyondLiq = pullU >= uq;
    const yBeyond = (yAt(pullU) - yAt(uq)) * L.dir;
    positionFillV = beyondLiq ? clamp(1 - yBeyond / 40, 0.12, 1) : 1;
    hud();
    ariaValue();
    lastInput = performance.now();
    if (!motionOn()) paintStatic();
  }
  function release() {
    if (mode !== 'pull') return;
    clearTimeout(keyTimer);
    const wasTouched = touched;
    const liquidated = beyondLiq;
    levelThickTarget = 3;
    if (motionOn()) {
      mode = 'release';
      rel.x = pullU;
      rel.v = 0;
    } else {
      mode = 'idle';
      levelThick = 3;
    }
    if (liquidated) {
      posOpen = false;
      positionFillV = 0;
    }
    if (wasTouched) {
      const hp = { x: L.headX, y: yAt(1) };
      marks.push(hist.length - 1);
      if (motionOn()) {
        pulseAt = hp;
        pulseT = 0;
        // the wallet keeps its total until the chip lands
        hud();
        seqTimers.push(window.setTimeout(stampImpact, 280));
        seqTimers.push(window.setTimeout(() => launchChip(hp), 400));
      } else {
        stamp.dataset.on = '1';
        payouts++;
      }
      say(liquidated ? I.verdicts.liquidated : I.verdicts.touch, motionOn() ? 420 : 0);
    } else say(I.verdicts.none, 0);
    hud();
    ariaValue();
    paintStatic();
  }
  function say(text: string, delay: number) {
    if (delay) seqTimers.push(window.setTimeout(() => (verdict.textContent = text), delay));
    else verdict.textContent = text;
  }

  function ariaValue() {
    const u = mode === 'pull' ? pullU : headU();
    const y = yAt(u);
    const d = distAt({ ...L, entryY: fr.e * h, levelY: fr.l * h, liqY: fr.q * h }, y);
    const side = state.setup.side;
    const moved = Math.abs(d) < 0.0005 ? 'at entry' : `${fmtPct(Math.abs(d))} ${(d > 0) === (side === 'long') ? 'below' : 'above'} entry`;
    const where = side === 'long' ? 'below' : 'above';
    let text = `Price ${moved}. Level ${fmtPct(est.lvlDist)} ${where}, liquidation ${fmtPct(est.liqDist)} ${where}.`;
    if (mode === 'pull' && beyondLiq) text += ' Past the liquidation price.';
    else if (mode === 'pull' && touched && u >= 1) text += ' Level touched.';
    handle.setAttribute('aria-valuenow', ((side === 'long' ? -d : d) * 100).toFixed(2));
    handle.setAttribute('aria-valuetext', text);
  }

  // pointer
  let dragging = false;
  handle.addEventListener('pointerdown', (ev) => {
    if (!ctx) return;
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    dragging = true;
    beginPull();
    handle.focus({ preventScroll: true });
  });
  handle.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const r = stage.getBoundingClientRect();
    movePull(uAt(clamp(ev.clientY - r.top, 4, h - 4)));
  });
  const up = () => {
    if (!dragging) return;
    dragging = false;
    release();
  };
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
  handle.addEventListener('lostpointercapture', up);

  // lean: the head notices a pointer within ~160 px
  stage.addEventListener('pointermove', (ev) => {
    if (dragging || !motionOn()) return;
    lastInput = performance.now();
    const r = stage.getBoundingClientRect();
    const hp = { x: L.headX, y: yAt(headU()) };
    const dx = ev.clientX - r.left - hp.x;
    const dy = ev.clientY - r.top - hp.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 160 && dist > 1) {
      const s = (1 - dist / 160) * 12;
      leanTarget = { x: (dx / dist) * s, y: (dy / dist) * s };
    } else leanTarget = { x: 0, y: 0 };
  });
  stage.addEventListener('pointerleave', () => (leanTarget = { x: 0, y: 0 }));

  // keyboard
  handle.addEventListener('keydown', (ev) => {
    if (!ctx) return;
    const stepPx = Math.max(4, Math.abs(fr.l * h - fr.e * h) / 8);
    const keys: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 3, PageUp: -3, ArrowRight: 0, ArrowLeft: 0 };
    if (ev.key in keys && keys[ev.key] !== 0) {
      ev.preventDefault();
      if (mode !== 'pull') beginPull();
      const y0 = yAt(pullU);
      let y = y0 + keys[ev.key] * stepPx;
      // stop exactly on the level, then just past the liquidation line, so each verdict is one key away
      const lY = fr.l * h;
      const qY = fr.q * h;
      const crosses = (a: number, b: number, line: number) => (a - line) * (b - line) < 0;
      if (Math.abs(y0 - lY) > 0.5 && crosses(y0, y, lY)) y = lY;
      else if (Math.abs(y0 - qY) > 0.5 && crosses(y0, y, qY + L.dir * 6)) y = qY + L.dir * 6;
      movePull(uAt(clamp(y, 4, h - 4)));
      clearTimeout(keyTimer);
      keyTimer = window.setTimeout(release, 1400);
    } else if (ev.key === 'Home' && mode === 'pull') {
      ev.preventDefault();
      movePull(baseU);
    } else if (['Enter', ' ', 'Escape'].includes(ev.key) && mode === 'pull') {
      ev.preventDefault();
      release();
    }
  });
  handle.addEventListener('blur', () => {
    if (mode === 'pull' && !dragging) release();
  });

  // ---- controls, live data, motion ---------------------------------------------------------------------------
  on('setup', () => {
    relayout(true);
    ariaValue();
    if (pullHint) pullHint.textContent = state.setup.side === 'long' ? I.pullHint : I.pullHint.replace('↓', '↑');
  });
  on('live', () => {
    liveTagText();
    labels();
  });
  onMotion((m) => {
    pauseBtn.setAttribute('aria-pressed', String(!m));
    if (!m) {
      if (mode === 'intro') endIntroNow();
      if (mode === 'release') mode = 'idle';
      if (chipFly.t >= 0) {
        chipFly.t = -1;
        chip.style.opacity = '0';
        payouts++;
      }
      lean = { x: 0, y: 0 };
      leanTarget = { x: 0, y: 0 };
      pulseT = -1;
      levelThick = levelThickTarget;
      glide.t0 = -1;
      fr = glide.to;
      hud();
      paintStatic();
    } else run.start();
  });
  pauseBtn.addEventListener('click', () => setMotion(!motionOn()));
  replayBtn.addEventListener('click', () => {
    if (motionOn()) startIntro();
    else endFrame();
  });

  // ---- boot --------------------------------------------------------------------------------------------------
  // a toggle button keeps its label; aria-pressed and the glyph carry the state
  pauseBtn.setAttribute('aria-pressed', String(!motionOn()));
  labels();
  liveTagText();
  if (!ctx) {
    // no 2D canvas: the static SVG stays; the handle has nothing to pull
    handle.hidden = true;
    return;
  }
  canvas.hidden = false;
  svg.style.display = 'none';
  stage.classList.add('js-canvas');
  size();
  resetHistory(true);
  new ResizeObserver(() => {
    size();
    paintStatic();
  }).observe(stage);
  ariaValue();
  if (motionOn()) startIntro();
  else endFrame();
}
