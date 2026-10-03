// The hero instrument (build spec 2.3, 2.4): a Canvas2D chart of a SIM price path against the position's
// liquidation line and the cover's level. The visitor can pull the price head (pointer or keyboard) and see
// what cover does on a touch. The canvas is aria-hidden; every meaning is also in DOM text.
//
// One setup is one cover, and a cover pays once (on chain it becomes Paid in the trigger transaction). A new
// cover starts only on Replay or a control change. A setup the engine refuses has no cover: a touch then pays
// nothing, and the stage says so.
import {
  estimate,
  fmtPct,
  fmtPrice,
  fmtLevelPrice,
  fmtUsd,
  premiumDollars,
  liqPrice,
  defaultLevel,
  px6ToUsd,
  type Estimate,
} from '../lib/pricing.ts';
import { layout, historyU, liqTicks, distAt, labelTops, pathD, MARK_GREEN, MARK_NAVY, PATH_STEP, SVG_HEAD_FRAC, type Layout } from '../lib/geometry.ts';
import { instrument as I } from '../copy/en.ts';
import { loop, motionOn, onMotion, setMotion, clamp, lerp, expoOut, easeIn, smooth, spring } from './motion.ts';
import { state, on } from './store.ts';

const C = {
  paper: '248,242,239',
  green: '35,183,121',
  navy: '67,92,122',
};
const rgba = (c: string, a: number) => `rgba(${c},${a})`;
const SEED = 20261002;
const SCROLL_PX_S = 52; // history scroll speed
const INTRO_S = 4.4;

type Mode = 'wait' | 'intro' | 'idle' | 'pull' | 'release';
type Hl = 'liq' | 'level' | 'prem' | 'cap' | null;

export function mountInstrument(root: HTMLElement): void {
  const stage = root.querySelector<HTMLElement>('[data-stage]')!;
  const canvas = stage.querySelector<HTMLCanvasElement>('canvas')!;
  const svg = stage.querySelector<SVGSVGElement>('.fallback')!;
  const handle = stage.querySelector<HTMLElement>('[data-handle]')!;
  const verdict = root.querySelector<HTMLElement>('[data-verdict]')!;
  const wallet = stage.querySelector<HTMLElement>('[data-wallet]')!;
  const walletLabel = stage.querySelector<HTMLElement>('[data-wallet-label]')!;
  const walletValue = stage.querySelector<HTMLElement>('[data-wallet-value]')!;
  const stamp = stage.querySelector<HTMLElement>('[data-stamp]')!;
  const chip = stage.querySelector<HTMLElement>('[data-chip]')!;
  const pullHint = stage.querySelector<HTMLElement>('[data-pull-hint]');
  const position = stage.querySelector<HTMLElement>('[data-position]')!;
  const positionText = stage.querySelector<HTMLElement>('[data-position-text]')!;
  const positionFill = stage.querySelector<HTMLElement>('[data-position-fill]')!;
  const halo = root.querySelector<HTMLElement>('.halo');
  const instHint = root.querySelector<HTMLElement>('#inst-hint');
  const card = document.querySelector<HTMLElement>('[data-card]');
  const lbl = (k: string) => stage.querySelector<HTMLElement>(`[data-lbl="${k}"]`)!;
  const levelVal = stage.querySelector<HTMLElement>('[data-level-val]')!;
  const levelNote = stage.querySelector<HTMLElement>('[data-level-note]');
  const liqVal = stage.querySelector<HTMLElement>('[data-liq-val]')!;
  const entryPx = stage.querySelector<HTMLElement>('[data-entry-px]')!;
  const levelPx = stage.querySelector<HTMLElement>('[data-level-px]')!;
  const liqPx = stage.querySelector<HTMLElement>('[data-liq-px]')!;
  const expiryVal = stage.querySelector<HTMLElement>('[data-expiry-val]')!;
  const liveTag = stage.querySelector<HTMLElement>('[data-live-tag]')!;
  const pauseBtn = root.querySelector<HTMLButtonElement>('[data-pause]')!;
  const pauseLabel = pauseBtn.querySelector<HTMLElement>('[data-pause-label]')!;
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
  let labelW = 220; // widest line label (px), measured; the head sits left of the labels
  // Narrow stages (≤ 640 px): the LIVE and SIM tags span the top of the stage. A long keeps the price below
  // them (entry at 40 %); a short, whose lines rise toward the top, ends its 2x liquidation at 26 % so the
  // lines and the pulled head stay under the tags. Wide stages: the tags sit top-left beside the wallet.
  const narrow = () => w > 0 && w <= 640;
  const frame = (): [number, number] => (!narrow() ? [0.3, 0.84] : state.setup.side === 'long' ? [0.4, 0.84] : [0.3, 0.74]);
  // The head's column ends HEAD_CLEAR px left of the widest label (ring 10 + lean 12 + air), so it never sits
  // on a label at any leverage; it may move as far left as 34 % of the stage to make that room.
  const HEAD_CLEAR = 32;
  const headXFor = (ww: number, expiryX: number) => Math.round(clamp(expiryX - 10 - labelW - HEAD_CLEAR, ww * 0.34, ww * 0.64));
  function mk(ww: number, hh: number): Layout {
    const T = layout(ww, hh, est.liqDist, est.lvlDist, state.setup.side, ...frame());
    T.headX = ctx && w > 0 ? headXFor(ww, T.expiryX) : Math.round(ww * SVG_HEAD_FRAC);
    return T;
  }
  let L: Layout = mk(1000, 560);
  // animated line positions as fractions of h (glide on setup changes)
  const glide = { from: { e: 0, l: 0, q: 0 }, to: { e: 0, l: 0, q: 0 }, t0: -1 };
  let fr = { e: L.entryY / L.h, l: L.levelY / L.h, q: L.liqY / L.h };
  glide.to = { ...fr };

  // ---- path state -------------------------------------------------------------------------------------
  let hist: number[] = [];
  let marks: number[] = []; // history indices of recorded touches (rings on the level)
  let paidMark = -1; // history index of the touch that paid (the trigger() stamp follows it)
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
  let rippleT = -1; // green ripple along the level after a paying touch
  let rippleX = 0;
  const chipFly = { t: -1, from: { x: 0, y: 0 }, to: { x: 0, y: 0 } };
  let seqTimers: number[] = [];
  let keyTimer = 0;
  let hintTimer = 0;
  let positionFillV = 1;
  let pulledOnce = false;
  let hl: Hl = null;
  // the cover of the current setup
  let paid = false;
  let posOpen = true;
  let landing = false; // a payout chip is in the air: the tile shows its old state until it lands
  type Kind = 'watching' | 'intro' | 'touch' | 'liquidated' | 'none' | 'paid' | 'paidClosed' | 'refused' | 'refusedClosed' | 'new';
  let kind: Kind = 'intro';

  const refused = () => est.refusal !== null;
  const reason = () => (est.refusal === 'prob_too_high' ? I.verdicts.reasonProb : I.verdicts.reasonLevel);
  const uw = () => state.role === 'underwriter';
  const premTxt = () => (est.premium === null ? '' : fmtUsd(premiumDollars(est.premium)));

  const nHist = () => Math.max(8, Math.ceil(L.headX / PATH_STEP) + 2);
  function resetHistory(withWick: boolean) {
    hist = historyU(nHist(), SEED, withWick);
    marks = withWick ? [Math.round(hist.length * 0.78)] : [];
    paidMark = withWick ? marks[0] : -1;
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
    if (mode === 'intro' || mode === 'wait') return introHeadU(introT);
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
  function target() {
    est = estimate(state.setup);
    const T = layout(1000, 1000, est.liqDist, est.lvlDist, state.setup.side, ...frame());
    return { e: T.entryY / 1000, l: T.levelY / 1000, q: T.liqY / 1000 };
  }
  function measureLabels() {
    const el = lbl('liq');
    const chars = (el.textContent ?? '').length || 20;
    const cw = el.offsetWidth / chars;
    if (!(cw > 0)) return;
    // The widest label text any setup can show, so the head does not jump between setups:
    // "Your level −0.28 % · not offered" (wide stages only; ≤ 640 px drop the suffix) or
    // "Liquidation −49.37 % · $123,456" ($ values only above 720 px viewports; a 1024 px window has a
    // narrow stage with $ values), else "Liquidation −49.37 %".
    const showPx = getComputedStyle(liqPx).display !== 'none';
    labelW = cw * (!narrow() ? 33 : showPx ? 31 : 21) * 1.04;
  }
  /** The vertical band the line labels may use: the stage minus the tiles that share the labels' column
   *  (LIVE/SIM tags, the wallet tile, the estimate strip on wide screens). As fractions of the stage height. */
  let band = { min: 0, max: 1 };
  const tiles = [stage.querySelector<HTMLElement>('.hud-tags'), wallet, position, root.querySelector<HTMLElement>('[data-strip]')];
  function measureBand() {
    const sr = stage.getBoundingClientRect();
    if (!(sr.width > 0 && sr.height > 0)) return;
    const right = (L.expiryX / L.w) * sr.width - 10;
    const left = right - Math.max(...(['entry', 'level', 'liq'] as const).map((k) => lbl(k).offsetWidth));
    let min = 0;
    let max = sr.height;
    for (const el of tiles) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      const x0 = r.left - sr.left;
      const x1 = r.right - sr.left;
      const y0 = r.top - sr.top;
      const y1 = r.bottom - sr.top;
      if (x1 <= left || x0 >= right || y1 <= 0 || y0 >= sr.height) continue;
      if ((y0 + y1) / 2 < sr.height / 2) min = Math.max(min, y1 + 4);
      else max = Math.min(max, y0 - 4);
    }
    band = { min: min / sr.height, max: max / sr.height };
  }
  function relayout(animate: boolean) {
    const to = target();
    if (animate && ctx && motionOn()) {
      glide.from = { ...fr };
      glide.to = to;
      glide.t0 = performance.now();
      run.start();
    } else {
      fr = to;
      glide.to = to;
      glide.t0 = -1;
    }
    L = mk(w || 1000, h || 560);
    stage.dataset.dir = String(L.dir);
    stage.dataset.refused = refused() ? '1' : '';
    labels();
    hud();
    if (!ctx) svgScene();
    paintStatic();
  }
  function size() {
    const r = stage.getBoundingClientRect();
    w = Math.max(1, Math.round(r.width));
    h = Math.max(1, Math.round(r.height));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    measureLabels();
    L = mk(w, h);
    const t = target();
    if (glide.t0 < 0) fr = t;
    glide.to = t;
    const n = nHist();
    if (hist.length < n) {
      const extra = historyU(n - hist.length, SEED + n, false);
      hist = extra.concat(hist);
      marks = marks.map((m) => m + extra.length);
      if (paidMark >= 0) paidMark += extra.length;
    } else if (hist.length > n) {
      const cut = hist.length - n;
      hist = hist.slice(cut);
      marks = marks.map((m) => m - cut).filter((m) => m >= 0);
      paidMark -= cut;
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
    if (levelNote) levelNote.hidden = !refused();
    if (px !== null) {
      const entry = px6ToUsd(px);
      const liq = liqPrice(entry, state.setup.lev, state.setup.maxLev, side);
      // a refused level shows "not offered" in place of its $ value (same label width, the head stays clear)
      levelPx.textContent = refused() ? '' : ` · ${fmtLevelPrice(defaultLevel(liq, side))}`;
      liqPx.textContent = ` · ${fmtLevelPrice(liq)}`;
      entryPx.textContent = ` · ${fmtPrice(entry)}`;
    } else entryPx.textContent = levelPx.textContent = liqPx.textContent = '';
    const dl = { 3600: '1h', 14400: '4h', 86400: '1d', 259200: '3d', 604800: '7d' } as Record<number, string>;
    expiryVal.textContent = dl[state.setup.dur] ?? '';
  }
  /** `measure`: re-read the free band first (setup, size, text or role changes; not on every glide frame). */
  function placeLabels(measure = false) {
    const hh = h || 560;
    if (measure) measureBand();
    // label height in stage units (the canvas-free SVG works in a 560-high frame)
    const lh = h ? 16 : (16 * hh) / (stage.clientHeight || hh);
    const t = labelTops(fr.e * hh, fr.l * hh, fr.q * hh, L.dir, lh, { min: band.min * hh, max: band.max * hh });
    const x = (L.expiryX / L.w) * 100;
    setXY(lbl('entry'), x, (t.entry / hh) * 100);
    setXY(lbl('level'), x, (t.level / hh) * 100);
    setXY(lbl('liq'), x, (t.liq / hh) * 100);
    setXY(lbl('expiry'), x, 100);
    placeStamp();
  }
  /** The trigger() stamp sits on the touch that paid; it scrolls away with it and hides near the left edge. */
  function placeStamp() {
    if (paidMark < 0 || !paid || refused()) {
      stamp.dataset.on = '0';
      return;
    }
    const ww = w || 1000;
    const x = ctx && w > 0 ? L.headX - scrollAcc - (hist.length - 1 - paidMark) * PATH_STEP : stampSvgX;
    stamp.style.setProperty('--x', ((x / ww) * 100).toFixed(3));
    stamp.style.setProperty('--y', (fr.l * 100).toFixed(3));
    // it sits left of the touch; with no room there (narrow stages) it moves to the right of it
    const px = ctx && w > 0 ? x : (x / 1000) * (stage.clientWidth || 1000);
    const side = px - (stamp.offsetWidth || 96) - 14 < 4 ? 'r' : 'l';
    if (stamp.dataset.side !== side) stamp.dataset.side = side;
    stamp.dataset.on = x < 30 ? '0' : '1';
  }
  let stampSvgX = 0;

  function liveTagText() {
    const s = state.live;
    liveTag.dataset.state = s.oracleState;
    if (s.oracleState === 'ok' && s.oraclePx6 !== null && s.oracleAt)
      liveTag.textContent = `${I.livePrefix} ${s.oracleAt.toISOString().slice(11, 19)} UTC`;
    else if (s.oracleState === 'failed') liveTag.textContent = I.liveFailed;
    else liveTag.textContent = I.liveWaiting;
  }

  // ---- HUD state (stamp, wallet / pool tile, position) --------------------------------------------------
  let tickRaf = 0;
  function hud() {
    const asPool = uw();
    walletLabel.textContent = asPool ? I.pool : I.wallet;
    wallet.dataset.role = asPool ? 'pool' : 'wallet';
    wallet.dataset.refused = refused() ? '1' : '0';
    wallet.dataset.paid = paid && !landing && !refused() ? '1' : '0';
    if (!tickRaf) walletValue.textContent = walletText();
    chip.textContent = asPool ? I.poolChip : I.payoutChip;
    position.dataset.state = posOpen ? 'open' : 'closed';
    positionText.textContent = posOpen ? I.positionOpen : I.positionClosed;
    positionFill.style.setProperty('--fill', String(posOpen ? positionFillV : 0));
    placeStamp();
  }
  function walletText(): string {
    const p = paid && !landing;
    if (uw()) return refused() ? I.poolNoSale : p ? I.poolPaid(premTxt()) : I.poolSold(premTxt());
    return refused() ? I.walletNoCover : p ? I.walletPaid : I.walletEmpty;
  }
  /** The payout is a state change, so the wallet value ticks from $0 to $100 (never a static figure). */
  function tickWallet() {
    cancelAnimationFrame(tickRaf);
    tickRaf = 0;
    if (!motionOn() || uw()) {
      walletValue.textContent = walletText();
      return;
    }
    const t0 = performance.now();
    const stepT = (now: number) => {
      const k = expoOut(clamp((now - t0) / 420, 0, 1));
      walletValue.textContent = I.walletPaid.replace('$100', `$${Math.round(100 * k)}`);
      if (k < 1) tickRaf = requestAnimationFrame(stepT);
      else {
        tickRaf = 0;
        walletValue.textContent = walletText();
      }
    };
    tickRaf = requestAnimationFrame(stepT);
  }
  function bump(el: HTMLElement, cls = 'bump') {
    el.classList.remove(cls);
    if (!motionOn()) return;
    void el.offsetWidth;
    el.classList.add(cls);
  }
  function stampImpact() {
    placeStamp();
    if (!motionOn()) return;
    // slam (120 ms ease-in), then a 3 px thud of the whole stage and a brief swell of the halo
    stamp.animate(
      [
        { scale: '1.6', opacity: 0 },
        { scale: '1', opacity: 1, offset: 0.4 },
        { translate: '0 3px', offset: 0.65 },
        { translate: '0 0', scale: '1', opacity: 1 },
      ],
      { duration: 300, easing: 'ease-in' },
    );
    stage.animate([{ translate: '0 0' }, { translate: '0 3px', offset: 0.35 }, { translate: '0 0' }], {
      duration: 240,
      delay: 110,
      easing: 'ease-out',
    });
    halo?.animate([{ opacity: 0.5 }, { opacity: 1, offset: 0.3 }, { opacity: 0.5 }], { duration: 1400, easing: 'ease-out' });
  }

  // ---- drawing --------------------------------------------------------------------------------------------
  let lastLa = '';
  const setLa = (v: string) => {
    if (v !== lastLa) stage.style.setProperty('--la', (lastLa = v));
  };
  function headPos(): { x: number; y: number } {
    const u = headU();
    let y = yAt(u);
    if (mode === 'pull' && performance.now() < detentUntil) y = yAt(1) + L.dir * 2;
    return { x: L.headX + lean.x, y: y + lean.y };
  }

  function draw() {
    if (!ctx) return;
    const c = ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const eY = fr.e * h;
    const lY = fr.l * h;
    const qY = fr.q * h;
    const dir = L.dir;
    const inIntro = mode === 'intro' || mode === 'wait';
    const morph = inIntro ? clamp(introT / 1.4, 0, 1) : 1;
    const linesA = inIntro ? clamp((introT - 0.85) / 0.55, 0, 1) : 1;
    // the line labels fade in with their lines
    const la = linesA.toFixed(2);
    setLa(la);
    const no = refused();

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
    // liquidation: dashed paper line with × ticks (brighter and thicker while its readout row is hovered)
    const liqHl = hl === 'liq';
    if (liqHl) {
      c.strokeStyle = rgba(C.paper, 0.16);
      c.lineWidth = 10;
      c.beginPath();
      c.moveTo(0, qY);
      c.lineTo(w, qY);
      c.stroke();
    }
    c.setLineDash([7, 6]);
    c.strokeStyle = rgba(C.paper, liqHl ? 1 : 0.8);
    c.lineWidth = liqHl ? 2.5 : 1.5;
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
    // level: solid green; dashed and thin when the setup is not offered (there is no cover to trigger)
    if (hl === 'level') {
      c.strokeStyle = rgba(C.green, 0.22);
      c.lineWidth = levelThick + 9;
      c.beginPath();
      c.moveTo(0, lY);
      c.lineTo(w, lY);
      c.stroke();
    }
    c.strokeStyle = rgba(C.green, 1);
    c.lineWidth = no ? 2 : levelThick + (hl === 'level' ? 1.5 : 0);
    if (no) c.setLineDash([10, 7]);
    c.beginPath();
    c.moveTo(0, lY);
    c.lineTo(w, lY);
    c.stroke();
    c.setLineDash([]);
    // ripple: a paying touch runs along the level both ways (about 400 ms, expo-out)
    if (rippleT >= 0 && rippleT < 0.45) {
      const k = expoOut(rippleT / 0.45);
      const d = k * w * 0.7;
      c.strokeStyle = rgba(C.green, 0.75 * (1 - k));
      c.lineWidth = 2 + 7 * (1 - k);
      c.beginPath();
      c.moveTo(Math.max(0, rippleX - d), lY);
      c.lineTo(Math.min(w, rippleX + d), lY);
      c.stroke();
    }
    c.globalAlpha = 1;

    // price path (+ the string bend toward the head)
    const reveal = inIntro ? expoOut(clamp((introT - 1.15) / 0.85, 0, 1)) : 1;
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

      // touch marks recorded in the history (only a cover's touches are recorded)
      c.strokeStyle = rgba(C.green, 1);
      c.lineWidth = 2;
      for (const m of marks) {
        const x = lastX - (n - 1 - m) * PATH_STEP;
        if (x < -10) continue;
        c.beginPath();
        c.arc(x, lY, m === paidMark ? 7 : 5, 0, Math.PI * 2);
        c.stroke();
      }

      if (reveal >= 0.98) {
        // keeper heartbeat: every 3 s, every 1 s near the level (build spec 2.4 #5); no cover, no keeper
        const near = Math.abs(distAt(L, hp.y) - est.lvlDist) < 0.01 || Math.abs(hu - 1) < 0.15;
        const period = near ? 1 : 3;
        const bt = (beatT % period) / 0.9;
        if (bt < 1 && motionOn() && !no) {
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

    // intro: the mark's two polygons part and fold flat into the liquidation line and the level
    if (inIntro && morph < 1) drawMorph(c, morph, qY, lY);
  }

  // Each polygon folds about its own centre: it travels to the stage centre on its line, stretches to the
  // stage width and flattens (scaleY -> 0). One affine map per polygon, so no vertex ever crosses another.
  const box = (pts: [number, number][]) => {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0 };
  };
  const BG = box(MARK_GREEN);
  const BN = box(MARK_NAVY);
  function drawMorph(c: CanvasRenderingContext2D, t: number, qY: number, lY: number) {
    const s = (h * 0.5) / 512;
    const mx = w * 0.5;
    const my = h * 0.47;
    const part = expoOut(clamp(t / 0.25, 0, 1)) * 14;
    const f = smooth(clamp((t - 0.16) / 0.84, 0, 1));
    const fade = 1 - smooth(clamp((t - 0.72) / 0.28, 0, 1));
    const poly = (pts: [number, number][], b: typeof BG, ty: number, dx: number, dy: number, col: string) => {
      const sx0 = mx + (b.cx - 256) * s + dx;
      const sy0 = my + (b.cy - 256) * s + dy;
      c.save();
      c.translate(lerp(sx0, w * 0.5, f), lerp(sy0, ty, f));
      c.scale(lerp(s, (w * 0.96) / b.w, f), lerp(s, s * 0.012, expoOut(f)));
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo(p[0] - b.cx, p[1] - b.cy) : c.moveTo(p[0] - b.cx, p[1] - b.cy)));
      c.closePath();
      c.globalAlpha = fade;
      c.fillStyle = col;
      c.fill();
      c.restore();
    };
    poly(MARK_NAVY, BN, qY, -part, part * 0.6, '#435c7a');
    poly(MARK_GREEN, BG, lY, part, -part * 0.6, '#23b779');
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
    if (mode === 'wait') {
      draw();
      return false; // nothing moves until the stage is in view
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
      paidMark -= 1;
    }
    beatT += dt;
    if (pulseT >= 0) pulseT += dt;
    if (pulseT > 0.4) pulseT = -1;
    if (rippleT >= 0) rippleT += dt;
    if (rippleT > 0.5) rippleT = -1;
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
        setLa('1');
        showHint();
      }
    } else if (mode === 'release') {
      spring(rel, baseU, dt, 190, 17);
      if (Math.abs(rel.x - baseU) < 0.004 && Math.abs(rel.v) < 0.02) mode = 'idle';
    }
    if (chipFly.t >= 0) flyChip(dt);
    placeStamp();
    draw();
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
      if (!refused()) {
        marks.push(hist.length - 1);
        paidMark = hist.length - 1;
        rippleX = hp.x;
        rippleT = 0;
      }
    }
    if (at(2.95)) {
      levelThickTarget = 3;
      if (refused()) say('refused');
      else {
        paid = true;
        landing = true;
        stampImpact();
        hud();
        // the verdict describes what has happened, at the moment it happens
        say('intro');
      }
    }
    if (at(3.08) && !refused()) launchChip({ x: L.headX, y: yAt(1) });
  }

  function launchChip(from: { x: number; y: number }) {
    if (!motionOn()) {
      landing = false;
      hud();
      return;
    }
    const sr = stage.getBoundingClientRect();
    const wr = wallet.getBoundingClientRect();
    // the chip lands on the tile's left part and never past the stage's right edge (it would be clipped)
    const tile = { x: Math.min(wr.left - sr.left + 8, sr.width - (chip.offsetWidth || 160) - 6), y: wr.top - sr.top + wr.height / 2 - 12 };
    const touch = { x: from.x - 40, y: from.y - 34 };
    // trader: the payout flies from the touch into the wallet; underwriter: it leaves the pool for the buyer
    chipFly.from = uw() ? tile : touch;
    chipFly.to = uw() ? touch : tile;
    chipFly.t = 0;
    chip.style.opacity = '1';
  }
  function flyChip(dt: number) {
    chipFly.t += dt / 0.48;
    const k = expoOut(clamp(chipFly.t, 0, 1));
    const x = lerp(chipFly.from.x, chipFly.to.x, k);
    const y = lerp(chipFly.from.y, chipFly.to.y, k) - Math.sin(k * Math.PI) * 26;
    chip.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${lerp(1, 0.86, k).toFixed(3)})`;
    if (chipFly.t >= 1) landChip();
  }
  function landChip() {
    chipFly.t = -1;
    chip.style.opacity = '0';
    landing = false;
    hud();
    tickWallet();
    bump(wallet);
  }

  // ---- static paint (motion off, or a frame while the loop is not running) -----------------------------------
  function paintStatic() {
    placeLabels(true);
    if (!ctx) return;
    if (!run.active) draw();
  }

  // ---- canvas unavailable: the static SVG follows the setup (same geometry module, same staged wick) -------
  const svgEl = <T extends SVGElement>(sel: string) => svg.querySelector<T>(sel);
  function svgScene() {
    const V = layout(1000, 560, est.liqDist, est.lvlDist, state.setup.side);
    V.headX = Math.round(1000 * SVG_HEAD_FRAC);
    const set = (el: Element | null, a: Record<string, string | number>) => {
      if (el) for (const [k, v] of Object.entries(a)) el.setAttribute(k, String(v));
    };
    set(svgEl('.zone'), { y: Math.min(V.liqY, V.edgeY), height: Math.abs(V.edgeY - V.liqY) });
    set(svgEl('.entry'), { y1: V.entryY, y2: V.entryY });
    set(svgEl('.liq'), { y1: V.liqY, y2: V.liqY });
    set(svgEl('.level'), { y1: V.levelY, y2: V.levelY });
    const ticks = liqTicks(V, 56);
    svg.querySelectorAll('.tick').forEach((t, i) => {
      const x = ticks[i] ?? -20;
      t.setAttribute('d', `M${x - 4} ${V.liqY - 4}L${x + 4} ${V.liqY + 4}M${x + 4} ${V.liqY - 4}L${x - 4} ${V.liqY + 4}`);
    });
    const n = Math.round(V.headX / PATH_STEP) + 1;
    set(svgEl('.price'), { d: pathD(V, historyU(n, SEED, true)) });
    const touchX = (Math.round(n * 0.78) * V.headX) / (n - 1);
    set(svgEl('.touch'), { cx: touchX, cy: V.levelY });
    stampSvgX = touchX;
    svg.dataset.refused = refused() ? '1' : '';
  }

  // ---- intro / replay / end frame ---------------------------------------------------------------------------
  function clearSeq() {
    seqTimers.forEach((t) => clearTimeout(t));
    seqTimers = [];
  }
  function newCover() {
    paid = false;
    landing = false;
    posOpen = true;
    positionFillV = 1;
    marks = [];
    paidMark = -1;
    chipFly.t = -1;
    chip.style.opacity = '0';
  }
  /** The staged wick, finished: the reduced-motion view, Replay with motion off and the canvas-free view. */
  function endFrame() {
    clearSeq();
    mode = 'idle';
    setLa('1');
    resetHistory(true);
    fr = target();
    glide.t0 = -1;
    newCover();
    if (!refused()) {
      marks = [Math.round(hist.length * 0.78)];
      paidMark = marks[0];
      paid = true;
    }
    levelThick = levelThickTarget = 3;
    say(refused() ? 'refused' : 'intro', 0, false);
    showHint();
    hud();
    paintStatic();
  }
  /** Frame 0 of the intro: the mark, waiting for the stage to come into view (phones start below the fold). */
  function prepIntro() {
    clearSeq();
    resetHistory(false);
    fr = target();
    glide.t0 = -1;
    mode = 'wait';
    introT = 0;
    hideHint();
    newCover();
    setLa('0');
    say('watching', 0, false);
    hud();
    paintStatic();
  }
  function startIntro() {
    if (!ctx || !motionOn()) {
      endFrame();
      return;
    }
    if (mode !== 'wait') prepIntro();
    mode = 'intro';
    introStart = performance.now();
    run.start();
  }
  function replay() {
    if (!ctx || !motionOn()) {
      endFrame();
      return;
    }
    prepIntro();
    startIntro();
  }

  // ---- pull the wick -------------------------------------------------------------------------------------
  function beginPull() {
    pulledOnce = true;
    hideHint();
    if (mode === 'intro' || mode === 'wait') endIntroNow();
    clearSeq();
    if (chipFly.t >= 0) landChip();
    // read where the head is drawn now (idle drift or a spring-back), before the mode switch
    const u0 = headU();
    mode = 'pull';
    pullU = u0;
    touched = false;
    beyondLiq = false;
    hud();
    lastInput = performance.now();
    run.start();
  }
  /** The visitor took over mid-intro: keep the path; the cover has paid only if the scripted touch happened. */
  function endIntroNow() {
    const reached = introT >= 2.95;
    introT = INTRO_S;
    mode = 'idle';
    setLa('1');
    if (!reached) {
      marks = [];
      paidMark = -1;
      paid = false;
    } else if (!refused()) paid = true;
    if (chipFly.t >= 0) landChip();
    landing = false;
    hud();
  }
  function movePull(u: number) {
    const before = pullU;
    const uq = uLiq();
    const lim = Math.max(uq * 1.25, uq + 0.2);
    pullU = clamp(u, -1.6, lim);
    if (Math.abs(pullU - 1) < 1e-6) pullU = 1; // the level is a touch (no floating-point miss)
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
    if (posOpen) positionFillV = beyondLiq ? clamp(1 - yBeyond / 40, 0.12, 1) : 1;
    hud();
    ariaValue();
    lastInput = performance.now();
    if (!motionOn()) paintStatic();
  }
  function release() {
    if (mode !== 'pull') return;
    clearTimeout(keyTimer);
    const wasTouched = touched;
    const liquidated = beyondLiq && posOpen;
    const wasOpen = posOpen;
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
    const hp = { x: L.headX, y: yAt(1) };
    if (refused()) {
      // no cover at these settings: nothing is recorded and nothing is paid
      say(liquidated || !wasOpen ? 'refusedClosed' : 'refused');
    } else if (!wasTouched) {
      say('none');
    } else if (!paid) {
      // the one payout of this cover
      paid = true;
      marks.push(hist.length - 1);
      paidMark = hist.length - 1;
      if (motionOn()) {
        landing = true; // the tile keeps its old state until the chip lands
        pulseAt = hp;
        pulseT = 0;
        rippleX = hp.x;
        rippleT = 0;
        seqTimers.push(window.setTimeout(stampImpact, 280));
        seqTimers.push(window.setTimeout(() => launchChip(hp), 400));
      }
      say(liquidated ? 'liquidated' : 'touch', motionOn() ? 420 : 0);
    } else {
      // already paid: the touch is recorded, nothing more is paid
      marks.push(hist.length - 1);
      if (motionOn()) {
        pulseAt = hp;
        pulseT = 0;
      }
      say(liquidated || !wasOpen ? 'paidClosed' : 'paid');
    }
    hud();
    ariaValue();
    paintStatic();
  }
  function textFor(k: Kind): string {
    const V = I.verdicts;
    const u = uw();
    switch (k) {
      case 'watching':
        return I.watching;
      case 'intro':
        return u ? V.uwTouch : I.introVerdict;
      case 'touch':
        return u ? V.uwTouch : V.touch;
      case 'liquidated':
        return u ? V.uwLiquidated : V.liquidated;
      case 'none':
        return u ? V.uwNone : V.none;
      case 'paid':
        return u ? V.uwPaid : V.paid;
      case 'paidClosed':
        return u ? V.uwPaid : V.paidLiquidated;
      case 'refused':
        return V.refused(reason());
      case 'refusedClosed':
        return `${V.refused(reason())} ${I.positionClosed}.`;
      default:
        return V.newCover;
    }
  }
  /** Writes the verdict (a polite live region). `announce` false updates it silently (setup changes are
   *  already announced by the readout summary). */
  function say(k: Kind, delay = 0, announce = true) {
    const put = () => {
      kind = k;
      const text = textFor(k);
      if (verdict.textContent === text) return;
      if (!announce) verdict.setAttribute('aria-live', 'off');
      verdict.textContent = text;
      if (!announce) window.setTimeout(() => verdict.setAttribute('aria-live', 'polite'), 50);
    };
    if (delay) seqTimers.push(window.setTimeout(put, delay));
    else put();
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

  // ---- pull hint: after the intro for ~6 s, again when the pointer comes near the head --------------------
  function showHint() {
    if (!pullHint || pulledOnce || !ctx) return;
    pullHint.dataset.off = '0';
    clearTimeout(hintTimer);
    // motion off: nothing changes by itself, so the hint stays until the first pull
    if (motionOn()) hintTimer = window.setTimeout(hideHint, 6000);
  }
  function hideHint() {
    clearTimeout(hintTimer);
    if (pullHint) pullHint.dataset.off = '1';
  }

  // pointer
  let dragging = false;
  const grab = (ev: PointerEvent) => {
    if (!ctx) return;
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    dragging = true;
    beginPull();
    handle.focus({ preventScroll: true });
  };
  handle.addEventListener('pointerdown', grab);
  // the hint is a real affordance: pressing it grabs the head
  pullHint?.addEventListener('pointerdown', grab);
  handle.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const r = stage.getBoundingClientRect();
    const y = clamp(ev.clientY - r.top, 4, h - 4);
    // a 3 px detent on the level: the pointer catches on it and it counts as a touch
    movePull(Math.abs(y - fr.l * h) <= 3 ? 1 : uAt(y));
  });
  const up = () => {
    if (!dragging) return;
    dragging = false;
    release();
  };
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
  handle.addEventListener('lostpointercapture', up);

  // lean: the head notices a pointer within ~160 px; near a line, the line and its readout row light up
  stage.addEventListener('pointermove', (ev) => {
    if (dragging) return;
    const r = stage.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const py = ev.clientY - r.top;
    const near = (y: number) => Math.abs(py - y) <= 9;
    if (ev.pointerType === 'mouse' && mode !== 'wait' && mode !== 'intro') {
      if (near(fr.l * h)) highlight('level');
      else if (near(fr.q * h)) highlight('liq');
    }
    if (!motionOn()) return;
    lastInput = performance.now();
    const hp = { x: L.headX, y: yAt(headU()) };
    const dx = px - hp.x;
    const dy = py - hp.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 160 && dist > 1) {
      const s = (1 - dist / 160) * 12;
      leanTarget = { x: (dx / dist) * s, y: (dy / dist) * s };
      if (mode === 'idle' && pullHint?.dataset.off === '1' && !pulledOnce) showHint();
    } else leanTarget = { x: 0, y: 0 };
  });
  stage.addEventListener('pointerleave', () => (leanTarget = { x: 0, y: 0 }));

  // keyboard: Down/Left lower the value, Up/Right raise it (ARIA slider pattern)
  handle.addEventListener('keydown', (ev) => {
    if (!ctx) return;
    const stepPx = Math.max(4, Math.abs(fr.l * h - fr.e * h) / 8);
    const keys: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, ArrowLeft: 1, ArrowRight: -1, PageDown: 3, PageUp: -3 };
    if (ev.key in keys) {
      ev.preventDefault();
      if (mode !== 'pull') beginPull();
      const y0 = yAt(pullU);
      // the value is the price: Down/Left move it down the chart, Up/Right up (aria-valuenow follows)
      let y = y0 + keys[ev.key] * stepPx;
      // stop exactly on the level, then just past the liquidation line, so each verdict is one key away
      const lY = fr.l * h;
      const qY = fr.q * h;
      const crosses = (a: number, b: number, line: number) => (a - line) * (b - line) < 0;
      if (Math.abs(y0 - lY) > 0.5 && crosses(y0, y, lY)) movePull(1);
      else if (Math.abs(y0 - qY) > 0.5 && crosses(y0, y, qY + L.dir * 6)) movePull(uAt(qY + L.dir * 6));
      else {
        y = clamp(y, 4, h - 4);
        movePull(uAt(y));
      }
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

  // ---- hover is explanation: readout rows <-> lines and tiles on the stage ---------------------------------
  function highlight(k: Hl) {
    if (k === hl) return;
    hl = k;
    for (const el of [lbl('level'), lbl('liq'), wallet, position]) el.classList.remove('hl');
    if (k === 'level') lbl('level').classList.add('hl');
    if (k === 'liq') lbl('liq').classList.add('hl');
    if (k === 'prem') wallet.classList.add('hl');
    if (k === 'cap') position.classList.add('hl');
    card?.querySelectorAll<HTMLElement>('[data-hl]').forEach((r) => r.classList.toggle('hl', r.dataset.hl === k));
    paintStatic();
  }
  card?.addEventListener('pointerover', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-hl]');
    if (row) highlight(row.dataset.hl as Hl);
  });

  // ---- controls, live data, role, motion ---------------------------------------------------------------------
  let setupTimer = 0;
  on('setup', () => {
    const before = est.refusal;
    relayout(true);
    ariaValue();
    if (pullHint) pullHint.textContent = state.setup.side === 'long' ? I.pullHint : I.pullHint.replace('↓', '↑');
    if (!ctx) {
      // nothing to pull: the staged scene re-draws for the new setup
      endFrameStatic();
      return;
    }
    // a control change sells a new cover from now (a refused setup has none)
    clearSeq();
    if (mode === 'intro' || mode === 'wait') endIntroNow();
    if (mode === 'pull' || mode === 'release') mode = 'idle';
    newCover();
    hud();
    clearTimeout(setupTimer);
    const k: Kind = refused() ? 'refused' : 'new';
    setupTimer = window.setTimeout(() => say(k, 0, false), before !== est.refusal ? 0 : 250);
    paintStatic();
  });
  /** Canvas-free: the SVG keeps the staged end frame for whatever setup is chosen. */
  function endFrameStatic() {
    paid = !refused();
    paidMark = paid ? 0 : -1;
    posOpen = true;
    svgScene();
    hud();
    placeLabels(true);
    say(refused() ? 'refused' : 'intro', 0, false);
  }
  on('live', () => {
    liveTagText();
    labels();
    // $ values widen the labels, and the LIVE tag's text changes: the free band is re-read
    placeLabels(true);
  });
  // I trade / I underwrite: the same scene from the other side (wallet tile <-> pool tile, verdict wording)
  on('role', () => {
    hud();
    say(kind, 0, false);
    placeLabels(true); // the pool tile's text can change its height
  });
  function pauseUi(m: boolean) {
    // the label says what a press will do; no aria-pressed (the name changes instead)
    pauseLabel.textContent = m ? I.pause : I.resume;
    pauseBtn.dataset.state = m ? 'running' : 'paused';
  }
  onMotion((m) => {
    pauseUi(m);
    if (!m) {
      cancelAnimationFrame(tickRaf);
      tickRaf = 0;
      // pausing mid-intro shows the finished staged scene (the same view as reduced motion)
      if (mode === 'intro' || mode === 'wait') endFrame();
      if (mode === 'release') mode = 'idle';
      if (chipFly.t >= 0) landChip();
      lean = { x: 0, y: 0 };
      leanTarget = { x: 0, y: 0 };
      pulseT = -1;
      rippleT = -1;
      levelThick = levelThickTarget;
      glide.t0 = -1;
      fr = glide.to;
      setLa('1');
      hideHint();
      hud();
      paintStatic();
    } else if (ctx) run.start();
  });
  pauseBtn.addEventListener('click', () => setMotion(!motionOn()));
  replayBtn.addEventListener('click', replay);

  /**
   * The intro plays only when what it carries is on screen: the level line with the touch and the trigger()
   * stamp (±40 px), and the whole wallet tile, which sits at the stage's bottom edge on phones. A share of the
   * stage is not enough: on a 430 px phone 60 % of it is in view on load while the level and the wallet are
   * not. A stage taller than the window (zoom, landscape phones) starts once it fills 90 % of the window.
   */
  function whenMomentInView(f: () => void) {
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (!e.isIntersecting) continue;
          const vh = e.rootBounds?.height || window.innerHeight;
          const sr = e.boundingClientRect;
          const wr = wallet.getBoundingClientRect();
          const ly = sr.top + fr.l * sr.height;
          const seen = wr.top >= 0 && wr.bottom <= vh && Math.max(ly - 40, sr.top) >= 0 && Math.min(ly + 40, sr.bottom) <= vh;
          if (seen || e.intersectionRect.height >= 0.9 * vh) {
            io.disconnect();
            f();
            return;
          }
        }
      },
      { threshold: Array.from({ length: 41 }, (_, i) => i / 40) },
    );
    io.observe(stage);
  }

  // ---- boot --------------------------------------------------------------------------------------------------
  pauseBtn.removeAttribute('aria-pressed');
  pauseUi(motionOn());
  labels();
  liveTagText();
  stage.dataset.refused = refused() ? '1' : '';
  // the pre-paint end frame (path, stamp, wallet, verdict) is hidden with motion on until this point
  root.classList.add('mounted');
  if (!ctx) {
    // no 2D canvas: the static SVG stays and follows the setup; there is nothing to pull
    handle.hidden = true;
    if (pullHint) pullHint.hidden = true;
    if (instHint) instHint.hidden = true;
    stage.classList.add('no-canvas');
    endFrameStatic();
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
  document.fonts?.ready.then(() => {
    measureLabels();
    size();
    paintStatic();
  });
  ariaValue();
  if (motionOn()) {
    prepIntro();
    whenMomentInView(() => {
      if (mode === 'wait') startIntro();
    });
  } else endFrame();
}
