// S3: the six parts as an ARIA tablist (arrows, Home, End; hover, focus or tap selects and the selection
// persists) over one shared canvas stage. The selected part works harder: its flow speeds up ~2.5× over
// ~400 ms and it brightens. The stage is schematic and aria-hidden; the panels carry the meaning.
import { estimate, fmtPrice, px6ToUsd } from '../lib/pricing.ts';
import { cascadeFull } from '../lib/cascade.ts';
import { steps, how as Hw, instrument as I } from '../copy/en.ts';
import { loop, motionOn, onMotion, clamp, lerp, expoOut } from './motion.ts';
import { state, on } from './store.ts';

const P = '248,242,239';
const G = '35,183,121';
const N = '67,92,122';
const rgba = (c: string, a: number) => `rgba(${c},${a})`;
const IDS = steps.map((s) => s.id);

export function mountSteps(root: HTMLElement): void {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
  const canvas = root.querySelector<HTMLCanvasElement>('[data-stage-canvas]')!;
  const box = canvas.parentElement!;
  const checks = root.querySelector<HTMLOListElement>('[data-checks]');
  const engineRow = root.querySelector<HTMLElement>('[data-engine]');
  const cascadeEnd = root.querySelector<HTMLElement>('[data-cascade-end]');
  const oracleTag = root.querySelector<HTMLElement>('[data-oracle-tag]');
  const oraclePx = root.querySelector<HTMLElement>('[data-oracle-px]');
  let sel = 0;
  let boostT0 = -1;
  let boost = 1;

  // ---- tabs ----
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
    frag.append(' ');
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

  // ---- cascade (Buy cover) ----
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
  on('setup', () => {
    renderCascade(IDS[sel] === 'buy');
    paint();
  });
  renderCascade(false);

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
  });

  // ---- stage canvas ----
  const ctx = (() => {
    try {
      return canvas.getContext('2d');
    } catch {
      return null;
    }
  })();
  let w = 0;
  let h = 0;
  let dpr = 1;
  let t = 0;
  let pts: { x: number; y: number }[] = [];
  let seg: number[] = [];
  let total = 1;
  const packets = Array.from({ length: 9 }, (_, i) => i / 9);

  function size() {
    const r = box.getBoundingClientRect();
    w = Math.max(1, Math.round(r.width));
    h = Math.max(1, Math.round(r.height));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const narrow = w < 640;
    pts = IDS.map((_, i) => {
      if (!narrow) return { x: (w * (i + 0.5)) / 6, y: h * 0.58 };
      const row = i < 3 ? 0 : 1;
      const col = row === 0 ? i : 5 - i;
      return { x: (w * (col + 0.5)) / 3, y: row === 0 ? h * 0.36 : h * 0.83 };
    });
    seg = [0];
    for (let i = 1; i < pts.length; i++) seg.push(seg[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    total = seg[seg.length - 1] || 1;
  }
  function at(s: number) {
    const d = (((s % 1) + 1) % 1) * total;
    let i = 1;
    while (i < seg.length - 1 && seg[i] < d) i++;
    const k = (d - seg[i - 1]) / (seg[i] - seg[i - 1] || 1);
    return { x: lerp(pts[i - 1].x, pts[i].x, k), y: lerp(pts[i - 1].y, pts[i].y, k) };
  }

  function draw() {
    if (!ctx || !pts.length) return;
    const c = ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    // track
    c.strokeStyle = rgba(P, 0.16);
    c.lineWidth = 2;
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
    c.stroke();
    // packets
    for (const s of packets) {
      const p = at(s);
      const near = Math.hypot(p.x - pts[sel].x, p.y - pts[sel].y) < 70;
      c.fillStyle = near ? rgba(G, 1) : rgba(P, 0.75);
      c.beginPath();
      c.arc(p.x, p.y, near ? 3.6 : 2.6, 0, Math.PI * 2);
      c.fill();
    }
    // stations
    const narrow = w < 640;
    const cell = Math.min(w / (narrow ? 3 : 6), 170);
    pts.forEach((p, i) => {
      const on = i === sel;
      c.fillStyle = rgba('12,21,32', 1);
      c.strokeStyle = on ? rgba(G, 1) : rgba(P, 0.35);
      c.lineWidth = on ? 2.5 : 1.5;
      c.beginPath();
      c.arc(p.x, p.y, 9, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      if (on) {
        c.fillStyle = rgba(G, 1);
        c.beginPath();
        c.arc(p.x, p.y, 4, 0, Math.PI * 2);
        c.fill();
      }
      c.font = `${on ? 600 : 500} 11px 'JetBrains Mono Variable', ui-monospace, monospace`;
      c.textAlign = 'center';
      c.fillStyle = on ? rgba(P, 1) : rgba(P, 0.62);
      c.fillText(steps[i].label, p.x, p.y + 28);
      glyph(c, IDS[i], p.x, p.y - Math.min(64, cell * 0.44), on, Math.min(1.3, cell / 120));
    });
  }

  function glyph(c: CanvasRenderingContext2D, id: string, x: number, y: number, on: boolean, s: number) {
    const a = on ? 1 : 0.55;
    const tt = t;
    c.save();
    c.translate(x, y);
    c.scale(s, s);
    c.lineWidth = 2;
    if (id === 'quote') {
      const left = 1 - (tt % 30) / 30;
      c.strokeStyle = rgba(P, 0.15);
      c.beginPath();
      c.arc(0, 0, 20, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = rgba(G, a);
      c.beginPath();
      c.arc(0, 0, 20, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2);
      c.stroke();
      c.fillStyle = rgba(P, a);
      c.font = "600 11px 'JetBrains Mono Variable', ui-monospace, monospace";
      c.textAlign = 'center';
      c.fillText(`${Math.ceil(left * 30)} s`, 0, 4);
    } else if (id === 'buy') {
      const cc = cascadeFull(state.setup, estimate(state.setup));
      const rows = cc.rows;
      const step = Math.floor((tt * 6) % (rows.length + 6));
      rows.forEach((r, k) => {
        const cx = -33 + (k % 6) * 13;
        const cy = -8 + Math.floor(k / 6) * 15;
        const lit = k < step;
        c.beginPath();
        c.arc(cx, cy, 4, 0, Math.PI * 2);
        if (cc.engineRefused) {
          c.strokeStyle = rgba(P, 0.4 * a);
          c.lineWidth = 1;
          c.stroke();
        } else if (r.state === 'fail' && lit) {
          c.strokeStyle = rgba(P, a);
          c.lineWidth = 2;
          c.stroke();
        } else if (r.state === 'skip' || !lit) {
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
      c.strokeRect(-26, -16, 52, 32);
      c.fillStyle = rgba(P, a);
      c.font = "600 10px 'JetBrains Mono Variable', ui-monospace, monospace";
      c.textAlign = 'center';
      c.fillText('0x…0807', 0, 4);
      const blink = (tt % 3) / 3;
      c.fillStyle = rgba(G, (1 - blink) * a);
      c.beginPath();
      c.arc(22, -16, 4, 0, Math.PI * 2);
      c.fill();
    } else if (id === 'keeper') {
      const ang = ((tt % 3) / 3) * Math.PI * 2 - Math.PI / 2;
      c.strokeStyle = rgba(P, 0.2);
      c.beginPath();
      c.arc(0, 0, 20, 0, Math.PI * 2);
      c.stroke();
      for (let k = 0; k < 10; k++) {
        c.strokeStyle = rgba(G, (a * (10 - k)) / 18);
        c.beginPath();
        c.moveTo(0, 0);
        const aa = ang - k * 0.09;
        c.lineTo(Math.cos(aa) * 20, Math.sin(aa) * 20);
        c.stroke();
      }
    } else if (id === 'pool') {
      c.strokeStyle = rgba(P, 0.5 * a);
      c.lineWidth = 1.5;
      c.strokeRect(-24, -20, 48, 40);
      const cyc = tt % 4;
      const blocks = cyc < 1 ? 1 : cyc < 2 ? 2 : cyc < 3 ? 3 : 2;
      for (let k = 0; k < blocks; k++) {
        const drop = k === blocks - 1 && cyc % 1 < 0.35 ? (1 - expoOut((cyc % 1) / 0.35)) * -26 : 0;
        c.fillStyle = rgba(N, 1);
        c.fillRect(-20, 10 - k * 11 + drop, 40, 8);
        c.strokeStyle = rgba(G, a);
        c.lineWidth = 1;
        c.strokeRect(-20, 10 - k * 11 + drop, 40, 8);
      }
    } else if (id === 'payout') {
      const k = (tt % 2.4) / 2.4;
      const up = Math.floor(tt / 2.4) % 2 === 0;
      c.strokeStyle = rgba(P, 0.3);
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(-26, 0);
      c.lineTo(0, 0);
      c.lineTo(22, -16);
      c.moveTo(0, 0);
      c.lineTo(22, 16);
      c.stroke();
      const e = expoOut(clamp(k * 1.4, 0, 1));
      const px = e < 0.5 ? lerp(-26, 0, e * 2) : lerp(0, 22, (e - 0.5) * 2);
      const py = e < 0.5 ? 0 : lerp(0, up ? -16 : 16, (e - 0.5) * 2);
      c.fillStyle = up ? rgba(G, a) : rgba(P, 0.7 * a);
      c.beginPath();
      c.arc(px, py, 4.5, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  const run = loop('steps', box, (dt) => {
    t += dt;
    if (boostT0 >= 0) boost = lerp(1, 2.5, expoOut(clamp((performance.now() - boostT0) / 400, 0, 1)));
    for (let k = 0; k < packets.length; k++) {
      const p = at(packets[k]);
      const d = Math.hypot(p.x - pts[sel].x, p.y - pts[sel].y);
      const local = d < 90 ? boost : 1;
      packets[k] = (packets[k] + (dt * 0.07 * local) / Math.max(0.6, total / 900)) % 1;
    }
    draw();
  });
  function paint() {
    if (!run.active) draw();
  }
  if (ctx) {
    size();
    new ResizeObserver(() => {
      size();
      paint();
    }).observe(box);
    draw();
    run.start();
    onMotion((m) => (m ? run.start() : paint()));
  }
}
