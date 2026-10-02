// Page boot: nav (backdrop, Motion toggle, Join CTAs), section reveals, and every interactive section.
import { nav as N } from '../copy/en.ts';
import { motionOn, onMotion, onceVisible } from './motion.ts';
import { on } from './store.ts';
import { mountInstrument } from './instrument.ts';
import { mountReadout } from './readout.ts';
import { mountLanes } from './lanes.ts';
import { mountSteps } from './steps.ts';
import { mountToy } from './toy.ts';
import { startLive, mountLedger } from './live.ts';
import { mountProof } from './proof.ts';
import { mountJoin } from './join.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);

function guarded(name: string, f: () => void) {
  try {
    f();
  } catch (e) {
    // one broken section must not take the page down; the static markup stays usable
    console.warn(`[numera] ${name} not started`, e);
  }
}

export function boot(): void {
  // section reveals: once, on entry (the hero headline rises by CSS on load)
  for (const el of document.querySelectorAll<HTMLElement>('[data-reveal]')) {
    if (!motionOn()) el.classList.add('in');
    else onceVisible(el, () => el.classList.add('in'), 0.2);
  }
  onMotion((m) => {
    if (!m) for (const el of document.querySelectorAll('[data-reveal]')) el.classList.add('in');
  });

  const inst = $('[data-instrument]');
  if (inst) {
    guarded('readout', () => mountReadout(inst));
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
  const toy = $('[data-toy]');
  if (toy) guarded('toy', () => mountToy(toy));
  const proof = $('#proof');
  if (proof) guarded('proof', () => mountProof(proof));

  const joinSection = $('#join');
  let join: ReturnType<typeof mountJoin> | null = null;
  if (joinSection) guarded('join', () => (join = mountJoin(joinSection)));

  // every Join CTA goes to the one form: scroll, focus the handle, nudge the ticket
  for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-join]')) {
    a.addEventListener('click', (e) => {
      if (!join || !joinSection) return;
      e.preventDefault();
      joinSection.scrollIntoView({ behavior: motionOn() ? 'smooth' : 'auto', block: 'start' });
      join.focusForm();
    });
  }
  on('joined', (s) => {
    if (!s.joined) return;
    for (const c of document.querySelectorAll<HTMLElement>('.join-cta')) {
      c.classList.add('joined');
      const l = c.querySelector('.cta-label');
      if (l) l.textContent = N.joined;
    }
  });
}
