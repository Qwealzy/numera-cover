// Page boot: section reveals, the Join CTAs and every interactive section (the nav itself boots in nav.ts).
import { nav as N } from '../copy/en.ts';
import { motionOn, onMotion, onceVisible } from './motion.ts';
import { on } from './store.ts';
import { mountInstrument } from './instrument.ts';
import { mountReadout } from './readout.ts';
import { mountLanes } from './lanes.ts';
import { mountSteps } from './steps.ts';
import { mountToy } from './toy.ts';
import { startLive, mountLedger } from './live.ts';
import { mountJoin } from './join.ts';
import { mountProof } from './proof.ts';
import { mountJoinMark } from './joinmark.ts';
import { mountPriceYou } from './price.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const html = document.documentElement;

function guarded(name: string, f: () => void) {
  try {
    f();
  } catch (e) {
    // one broken section must not take the page down; the static markup stays usable
    console.warn(`[numera] ${name} not started`, e);
  }
}

export function boot(): void {
  // section reveals: once, on entry (the hero headline rises by CSS on load). Blocks are hidden only once
  // this module has attached its observers (html.reveals); if it never gets here, boot.js shows everything.
  guarded('reveals', () => {
    // section headings: wrap each word for the mask rise (text and spacing unchanged)
    if (motionOn())
      for (const h of document.querySelectorAll<HTMLElement>('[data-reveal] h2')) {
        const words = (h.textContent ?? '').trim().split(/\s+/);
        h.textContent = '';
        words.forEach((w, i) => {
          const outer = document.createElement('span');
          outer.className = 'rise';
          const inner = document.createElement('span');
          inner.style.setProperty('--i', String(i));
          inner.textContent = w;
          outer.append(inner);
          h.append(outer, i < words.length - 1 ? ' ' : '');
        });
      }
    const vh = window.innerHeight;
    for (const el of document.querySelectorAll<HTMLElement>('[data-reveal]')) {
      const r = el.getBoundingClientRect();
      // already on screen when this runs (it was painted visible): keep it, never hide what was seen
      if (!motionOn() || (r.top < vh && r.bottom > 0)) el.classList.add('in');
      else onceVisible(el, () => el.classList.add('in'), 0.12);
    }
    onMotion((m) => {
      if (!m) for (const el of document.querySelectorAll('[data-reveal]')) el.classList.add('in');
    });
    html.classList.add('reveals');
  });

  const hero = $('[data-hero]');
  const inst = $('[data-instrument]');
  if (hero) guarded('readout', () => mountReadout(hero));
  if (inst) {
    guarded('instrument', () => mountInstrument(inst));
    const d = inst.dataset;
    const pool = $('[data-ledger-root]')?.dataset.pool ?? '';
    guarded('live', () =>
      startLive({
        rpcs: (d.rpcs ?? '').split(' ').filter(Boolean),
        chain: Number(d.chain),
        oracle: d.oracle ?? '',
        perp: Number(d.perp),
        pool,
      }),
    );
  }
  const ledger = $('[data-ledger-root]');
  if (ledger) guarded('ledger', () => mountLedger(ledger));
  const lanes = $('[data-lanes]');
  if (lanes) guarded('lanes', () => mountLanes(lanes));
  const parts = $('[data-parts]');
  if (parts) guarded('steps', () => mountSteps(parts));
  const price = $('#price');
  if (price) guarded('price', () => mountPriceYou(price));
  const toy = $('[data-toy]');
  if (toy) guarded('toy', () => mountToy(toy));

  const run = $('[data-run]');
  if (run) guarded('proof', () => mountProof(run));

  const joinSection = $('#join');
  let join: ReturnType<typeof mountJoin> | null = null;
  if (joinSection) guarded('join', () => (join = mountJoin(joinSection)));
  if (joinSection) guarded('join-mark', () => mountJoinMark(joinSection));

  // every Join CTA goes to the one form: scroll, focus the email field, nudge the ticket.
  for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-join]')) {
    a.addEventListener('click', (e) => {
      if (!join || !joinSection) return;
      e.preventDefault();
      const target = joinSection.querySelector('[data-ticket]') ?? joinSection;
      join.focusForm(); // focus first (without scrolling), then scroll: a focus call can cut a smooth scroll short
      target.scrollIntoView({ behavior: motionOn() ? 'smooth' : 'auto', block: 'start' });
    });
  }
  on('joined', (s) => {
    if (!s.joined) return;
    for (const c of document.querySelectorAll<HTMLElement>('.join-cta:not([data-submit])')) {
      // "On the list" is shorter: the button keeps its width, so a CTA row that wrapped stays as it was and
      // nothing above the form moves (browsers without scroll anchoring would jump otherwise)
      const w = c.getBoundingClientRect().width;
      if (w > 0) c.style.minWidth = `${w}px`;
      c.classList.add('joined');
      for (const l of c.querySelectorAll('.cta-label, .cta-short')) l.textContent = N.joined;
    }
  });
}
