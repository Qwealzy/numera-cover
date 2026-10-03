// S3: the six parts as an ARIA tablist (arrows, Home, End; hover, focus or tap selects and the selection
// persists) over one shared canvas stage. The stage is one continuous flow:
//   Quote -> Buy cover -> Pool         (a quote is checked, the premium goes in, a payout is locked)
//   Oracle -> Keeper -> Payout <- Pool (the keeper reads the oracle and fires trigger(); the pool pays out)
// The selected part works harder: its connectors thicken (about 2.7x) and brighten, and their packet stream
// speeds up about 2.5x over ~400 ms. The stage is schematic and aria-hidden; the panels carry the meaning.
import { estimate, fmtPrice, fmtPct, fmtUsd, premiumDollars, px6ToUsd } from '../lib/pricing.ts';
import { cascadeFull } from '../lib/cascade.ts';
import { steps, how as Hw, instrument as I, controls as C } from '../copy/en.ts';
import { loop, motionOn, onMotion, clamp, lerp, expoOut, type LoopHandle } from './motion.ts';
import { state, on } from './store.ts';

const P = '248,242,239';
const G = '35,183,121';
const N = '67,92,122';
const rgba = (c: string, a: number) => `rgba(${c},${a})`;
const IDS = steps.map((s) => s.id);
const MONO = "'JetBrains Mono Variable', ui-monospace, monospace";

// station grid: [column, row]
const AT: Record<string, [number, number]> = {
  quote: [0, 0],
  buy: [1, 0],
  pool: [2, 0],
  oracle: [0, 1],
  keeper: [1, 1],
  payout: [2, 1],
};
// connectors in flow order; each lights up when either end is selected
const EDGES: { a: string; b: string; kind: 'quote' | 'premium' | 'tick' | 'trigger' | 'payout' }[] = [
  { a: 'quote', b: 'buy', kind: 'quote' },
  { a: 'buy', b: 'pool', kind: 'premium' },
  { a: 'oracle', b: 'keeper', kind: 'tick' },
  { a: 'keeper', b: 'payout', kind: 'trigger' },
  { a: 'pool', b: 'payout', kind: 'payout' },
];

export function mountSteps(root: HTMLElement): void {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = [...root.querySelectorAll<HTMLElement>('[data-panel]')];
  const canvas = root.querySelector<HTMLCanvasElement>('[data-stage-canvas]')!;
  const box = canvas.parentElement!;
  const checks = root.querySelector<HTMLOListElement>('[data-checks]');
  const engineRow = root.querySelector<HTMLElement>('[data-engine]');
  const cascadeEnd = root.querySelector<HTMLElement>('[data-cascade-end]');
  const oracleTag = root.querySelector<HTMLElement>('[data-oracle-tag]');
  const oraclePx = root.querySelector<HTMLElement>('[data-oracle-px]');
  const qcard = root.querySelector<HTMLElement>('[data-qcard]');
  const pcard = root.querySelector<HTMLElement>('[data-pcard]');
  let sel = 0;
  let boostT0 = -1;
  let boost = 1;
  // the stage loop exists only when a 2D context does; handlers registered before it must not touch it
  let run: LoopHandle | null = null;
  let ctx: CanvasRenderingContext2D | null = null;

  // ---- tablist semantics are added here, so without JS the parts stay plain sections with headings ----
  panels.forEach((p, k) => {
    p.setAttribute('role', 'tabpanel');
    p.tabIndex = 0;
    p.setAttribute('aria-labelledby', tabs[k]?.id ?? '');
  });
  root.classList.add('tabs-on');

  function select(i: number, focus = false) {
    if (i === sel && !focus) return;
    const changed = i !== sel;
    sel = i;
    tabs.forEach((t, k) => {
      t.setAttribute('aria-selected', String(k === i));
      t.tabIndex = k === i ? 0 : -1;
    });
    panels.forEach((p, k) => show(p, k === i));
    if (focus) tabs[i].focus();
    if (changed) {
      const cap = panels[i].querySelector<HTMLElement>('[data-caption]');
      if (cap && motionOn()) {
        cap.classList.remove('swap');
        void cap.offsetWidth;
        cap.classList.add('swap');
      }
      if (IDS[i] === 'buy') renderCascade(true);
      boostT0 = performance.now();
      boost = 1;
      paint();
    }
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(i));
    t.addEventListener('focus', () => select(i));
    t.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') select(i);
    });
    t.addEventListener('keydown', (e) => {
      const n = tabs.length;
      const to: Record<string, number> = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 };
      if (e.key in to) {
        e.preventDefault();
        select(to[e.key], true);
      }
    });
  });
  // the shown panel; the others are hidden from view, focus and assistive tech, and keep their size
  function show(p: HTMLElement, on: boolean) {
    p.classList.toggle('off', !on);
    p.inert = !on;
    if (on) p.removeAttribute('aria-hidden');
    else p.setAttribute('aria-hidden', 'true');
  }
  panels.forEach((p, k) => show(p, k === sel));
  // captions: wrap each word so a swap can rise word by word (the text and its spaces stay the same)
  for (const cap of root.querySelectorAll<HTMLElement>('[data-caption]')) {
    const node = [...cap.childNodes].find((n) => n.nodeType === 3 && (n.textContent ?? '').trim());
    if (!node) continue;
    const words = (node.textContent ?? '').trim().split(/\s+/);
    const frag = document.createDocumentFragment();
    words.forEach((w, i) => {
      const outer = document.createElement('span');
      outer.className = 'rise';
      const inner = document.createElement('span');
      inner.style.setProperty('--i', String(i));
      inner.textContent = w;
      outer.append(inner);
      frag.append(outer, i < words.length - 1 ? ' ' : '');
    });
    node.replaceWith(frag);
  }

  // ---- cascade (Buy cover), quote card and pool card follow the hero setup ----
  function renderCascade(animate: boolean) {
    if (!checks) return;
    const c = cascadeFull(state.setup, estimate(state.setup));
    if (engineRow) engineRow.hidden = !c.engineRefused;
    const lis = [...checks.children] as HTMLElement[];
    c.rows.forEach((r, k) => {
      const li = lis[k];
      if (!li) return;
      li.dataset.state = r.state;
      li.style.setProperty('--k', String(k));
      li.querySelector('.c-state')!.textContent = r.stateText;
    });
    if (cascadeEnd) cascadeEnd.textContent = c.stopped ? Hw.station.buy.stopped : Hw.station.buy.done;
    if (animate && motionOn()) {
      checks.classList.remove('run');
      void checks.offsetWidth;
      checks.classList.add('run');
    }
  }
  function renderCards() {
    const s = state.setup;
    const e = estimate(s);
    const Q = Hw.quoteCard;
    const prem = e.premium === null ? '' : fmtUsd(premiumDollars(e.premium));
    const q = (k: string) => qcard?.querySelector<HTMLElement>(`[data-q="${k}"]`);
    if (qcard) {
      qcard.dataset.refused = e.refusal ? '1' : '';
      const r = q('refused');
      if (r) r.hidden = !e.refusal;
      const set = (k: string, v: string) => {
        const el = q(k);
        if (el) el.textContent = v;
      };
      set('side', s.side);
      set('level', `${fmtPct(e.lvlDist)} ${s.side === 'long' ? Q.below : Q.above}`);
      set('premium', prem);
      set('expiry', Q.fromNow(C.durations.find((x) => x.sec === s.dur)?.label ?? ''));
    }
    if (pcard) {
      const res = pcard.querySelector<HTMLElement>('[data-p="reserved"]');
      const pr = pcard.querySelector<HTMLElement>('[data-p="premium"]');
      if (res) res.textContent = e.refusal ? Hw.poolCard.none : Hw.poolCard.reserved;
      if (pr) {
        pr.hidden = !!e.refusal;
        pr.textContent = Hw.poolCard.premium(prem);
      }
    }
  }
  on('setup', () => {
    renderCascade(IDS[sel] === 'buy');
    renderCards();
    paint();
  });
  renderCascade(false);
  renderCards();

  // ---- oracle panel ----
  on('live', () => {
    const s = state.live;
    if (oracleTag) {
      oracleTag.dataset.state = s.oracleState;
      oracleTag.textContent =
        s.oracleState === 'ok' && s.oracleAt
          ? `${I.livePrefix} ${s.oracleAt.toISOString().slice(11, 19)} UTC`
          : s.oracleState === 'failed'
            ? I.liveFailed.replace(' · levels shown in % of entry', '')
            : I.liveWaiting;
    }
    if (oraclePx) oraclePx.textContent = s.oraclePx6 === null ? '—' : fmtPrice(px6ToUsd(s.oraclePx6));
    paint();
  });

  // ---- stage canvas ----
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) {
    // nothing can be drawn: no empty box (and no empty column); the panels carry everything
    root.classList.add('no-stage');
    box.hidden = true;
    box.style.display = 'none';
    return;
  }
  let w = 0;
  let h = 0;
  let dpr = 1;
  let t = 0;
  let R = 40;
  const pos: Record<string, { x: number; y: number }> = {};
  // packet phases per edge (0..1 along the edge)
  const packets = EDGES.map((_, i) => [0, 1 / 3, 2 / 3].map((p) => (p + i * 0.17) % 1));

  function size() {
    const r = box.getBoundingClientRect();
    w = Math.max(1, Math.round(r.width));
    h = Math.max(1, Math.round(r.height));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const cols = [0.18, 0.5, 0.82];
    const rows = [0.31, 0.71];
    for (const id of IDS) {
      const [c, rr] = AT[id];
      pos[id] = { x: w * cols[c], y: h * rows[rr] };
    }
    // stations at least 90 px wide on desktop; smaller only when the stage is phone-narrow
    R = clamp(Math.min(w * 0.085, h * 0.15), 26, 60);
  }

  const isOn = (id: string) => IDS[sel] === id;
  const edgeOn = (e: (typeof EDGES)[number]) => isOn(e.a) || isOn(e.b);
  /** Start and end of an edge on the station rims. */
  function ends(e: (typeof EDGES)[number]) {
    const a = pos[e.a];
    const b = pos[e.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const pad = R + 8;
    return { x0: a.x + (dx / d) * pad, y0: a.y + (dy / d) * pad, x1: b.x - (dx / d) * pad, y1: b.y - (dy / d) * pad, ux: dx / d, uy: dy / d };
  }

  function draw() {
    if (!ctx || !w) return;
    const c = ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    // connectors
    for (let i = 0; i < EDGES.length; i++) {
      const e = EDGES[i];
      const on = edgeOn(e);
      const p = ends(e);
      c.lineCap = 'round';
      if (on) {
        c.strokeStyle = rgba(G, 0.16);
        c.lineWidth = 12;
        c.beginPath();
        c.moveTo(p.x0, p.y0);
        c.lineTo(p.x1, p.y1);
        c.stroke();
      }
      c.strokeStyle = on ? rgba(G, 0.95) : rgba(P, 0.2);
      c.lineWidth = on ? 4 : 1.5;
      c.beginPath();
      c.moveTo(p.x0, p.y0);
      c.lineTo(p.x1, p.y1);
      c.stroke();
      // arrowhead
      const ah = on ? 9 : 7;
      c.fillStyle = on ? rgba(G, 0.95) : rgba(P, 0.32);
      c.beginPath();
      c.moveTo(p.x1, p.y1);
      c.lineTo(p.x1 - p.ux * ah - p.uy * ah * 0.6, p.y1 - p.uy * ah + p.ux * ah * 0.6);
      c.lineTo(p.x1 - p.ux * ah + p.uy * ah * 0.6, p.y1 - p.uy * ah - p.ux * ah * 0.6);
      c.closePath();
      c.fill();
      // packets
      for (const ph of packets[i]) {
        const x = lerp(p.x0, p.x1, ph);
        const y = lerp(p.y0, p.y1, ph);
        const fade = Math.min(1, ph * 6, (1 - ph) * 6);
        c.fillStyle = on ? rgba(G, fade) : rgba(P, 0.6 * fade);
        if (e.kind === 'quote') {
          const s = on ? 1.3 : 1;
          c.fillRect(x - 6 * s, y - 4 * s, 12 * s, 8 * s);
          c.fillStyle = rgba('12,21,32', 0.9 * fade);
          c.fillRect(x - 3 * s, y - 1 * s, 6 * s, 1.5 * s);
        } else {
          c.beginPath();
          c.arc(x, y, on ? 4 : 2.8, 0, Math.PI * 2);
          c.fill();
        }
      }
    }

    // stations
    for (const id of IDS) {
      const p = pos[id];
      const on = isOn(id);
      // breathing ring on the selected station
      if (on && motionOn()) {
        const k = (t % 1.8) / 1.8;
        c.strokeStyle = rgba(G, 0.35 * (1 - k));
        c.lineWidth = 2;
        c.beginPath();
        c.arc(p.x, p.y, R + 4 + 16 * expoOut(k), 0, Math.PI * 2);
        c.stroke();
      }
      c.fillStyle = rgba('12,21,32', 1);
      c.strokeStyle = on ? rgba(G, 1) : rgba(P, 0.3);
      c.lineWidth = on ? 2.5 : 1.5;
      c.beginPath();
      c.arc(p.x, p.y, R, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      glyph(c, id, p.x, p.y, on, (R / 40) * (on ? 1.06 : 1));
      // label: above the top row, below the bottom row
      const i = IDS.indexOf(id);
      const top = AT[id][1] === 0;
      c.font = `${on ? 700 : 500} ${R > 34 ? 12 : 10.5}px ${MONO}`;
      c.textAlign = 'center';
      c.textBaseline = top ? 'bottom' : 'top';
      c.fillStyle = on ? rgba(P, 1) : rgba(P, 0.66);
      c.fillText(`${String(i + 1).padStart(2, '0')} ${steps[i].label}`, p.x, top ? p.y - R - 12 : p.y + R + 12);
    }
    c.textBaseline = 'alphabetic';
  }

  function glyph(c: CanvasRenderingContext2D, id: string, x: number, y: number, on: boolean, s: number) {
    const a = on ? 1 : 0.6;
    const tt = t;
    c.save();
    c.translate(x, y);
    c.scale(s, s);
    c.lineWidth = 2;
    if (id === 'quote') {
      const left = 1 - (tt % 30) / 30;
      c.strokeStyle = rgba(P, 0.15);
      c.beginPath();
      c.arc(0, 0, 24, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = rgba(G, a);
      c.lineWidth = 3;
      c.beginPath();
      c.arc(0, 0, 24, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2);
      c.stroke();
      c.fillStyle = rgba(P, a);
      c.font = `700 12px ${MONO}`;
      c.textAlign = 'center';
      c.fillText(`${Math.ceil(left * 30)} s`, 0, 4);
    } else if (id === 'buy') {
      const cc = cascadeFull(state.setup, estimate(state.setup));
      const rows = cc.rows;
      const n = rows.length;
      const stepI = Math.floor((tt * 5) % (n + 5));
      rows.forEach((r, k) => {
        const row = k < 4 ? 0 : k < 8 ? 1 : 2;
        const col = k < 4 ? k : k < 8 ? k - 4 : k - 8;
        const cx = -16.5 + col * 11 + (row === 2 ? 5.5 : 0);
        const cy = -12 + row * 12;
        const lit = !motionOn() || k < stepI;
        c.beginPath();
        c.arc(cx, cy, 3.6, 0, Math.PI * 2);
        if (cc.engineRefused || r.state === 'skip') {
          c.setLineDash([2, 2]);
          c.strokeStyle = rgba(P, 0.45 * a);
          c.lineWidth = 1;
          c.stroke();
          c.setLineDash([]);
        } else if (r.state === 'fail' && lit) {
          c.strokeStyle = rgba(P, a);
          c.lineWidth = 2;
          c.stroke();
        } else if (!lit) {
          c.strokeStyle = rgba(P, 0.25);
          c.lineWidth = 1;
          c.stroke();
        } else {
          c.fillStyle = r.state === 'pass' ? rgba(G, a) : rgba(P, 0.55 * a);
          c.fill();
        }
      });
    } else if (id === 'oracle') {
      c.strokeStyle = rgba(P, 0.6 * a);
      c.lineWidth = 1.5;
      c.strokeRect(-25, -14, 50, 28);
      c.fillStyle = rgba(P, a);
      c.font = `600 9.5px ${MONO}`;
      c.textAlign = 'center';
      c.fillText('0x…0807', 0, 3.5);
      const blink = (tt % 3) / 3;
      c.fillStyle = rgba(G, (1 - blink) * a);
      c.beginPath();
      c.arc(22, -14, 4, 0, Math.PI * 2);
      c.fill();
    } else if (id === 'keeper') {
      // a sweep every ~3 s (how-it-works §8)
      const ang = ((tt % 3) / 3) * Math.PI * 2 - Math.PI / 2;
      c.strokeStyle = rgba(P, 0.2);
      c.beginPath();
      c.arc(0, 0, 24, 0, Math.PI * 2);
      c.stroke();
      for (let k = 0; k < 12; k++) {
        c.strokeStyle = rgba(G, (a * (12 - k)) / 20);
        c.beginPath();
        c.moveTo(0, 0);
        const aa = ang - k * 0.08;
        c.lineTo(Math.cos(aa) * 24, Math.sin(aa) * 24);
        c.stroke();
      }
      c.fillStyle = rgba(P, a);
      c.beginPath();
      c.arc(0, 0, 2.5, 0, Math.PI * 2);
      c.fill();
    } else if (id === 'pool') {
      c.strokeStyle = rgba(P, 0.55 * a);
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(-22, -22);
      c.lineTo(-22, 22);
      c.lineTo(22, 22);
      c.lineTo(22, -22);
      c.stroke();
      // the 80 % cap
      c.strokeStyle = rgba(G, 0.8 * a);
      c.beginPath();
      c.moveTo(-25, -13);
      c.lineTo(25, -13);
      c.stroke();
      const cyc = tt % 4;
      const blocks = motionOn() ? (cyc < 1 ? 1 : cyc < 2 ? 2 : cyc < 3 ? 3 : 2) : 2;
      for (let k = 0; k < blocks; k++) {
        const drop = motionOn() && k === blocks - 1 && cyc % 1 < 0.35 ? (1 - expoOut((cyc % 1) / 0.35)) * -26 : 0;
        c.fillStyle = rgba(N, 1);
        c.fillRect(-18, 12 - k * 10 + drop, 36, 8);
        c.strokeStyle = rgba(G, a);
        c.lineWidth = 1;
        c.strokeRect(-18, 12 - k * 10 + drop, 36, 8);
      }
    } else if (id === 'payout') {
      const k = (tt % 2.4) / 2.4;
      const up = !motionOn() || Math.floor(tt / 2.4) % 2 === 0;
      c.strokeStyle = rgba(P, 0.32);
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(-24, 0);
      c.lineTo(0, 0);
      c.lineTo(20, -15);
      c.moveTo(0, 0);
      c.lineTo(20, 15);
      c.stroke();
      const e = motionOn() ? expoOut(clamp(k * 1.4, 0, 1)) : 1;
      const px = e < 0.5 ? lerp(-24, 0, e * 2) : lerp(0, 20, (e - 0.5) * 2);
      const py = e < 0.5 ? 0 : lerp(0, up ? -15 : 15, (e - 0.5) * 2);
      c.fillStyle = up ? rgba(G, a) : rgba(P, 0.7 * a);
      c.beginPath();
      c.arc(px, py, 4.5, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  run = loop('steps', box, (dt) => {
    t += dt;
    if (boostT0 >= 0) boost = lerp(1, 2.5, expoOut(clamp((performance.now() - boostT0) / 400, 0, 1)));
    for (let i = 0; i < EDGES.length; i++) {
      const p = ends(EDGES[i]);
      const len = Math.max(40, Math.hypot(p.x1 - p.x0, p.y1 - p.y0));
      const v = (edgeOn(EDGES[i]) ? 70 * boost : 46) / len; // px/s along the connector
      packets[i] = packets[i].map((ph) => (ph + dt * v) % 1);
    }
    draw();
  });
  function paint() {
    if (run && !run.active) draw();
  }
  size();
  new ResizeObserver(() => {
    size();
    paint();
  }).observe(box);
  draw();
  run.start();
  onMotion((m) => (m ? run?.start() : paint()));
}
