// S6 recorded run, animated: the playhead sweeps the block track, the three calls (buyCover, setPrice,
// trigger) light up as it reaches their blocks, their receipt cards follow, and then the "3 s by block
// timestamps" bracket draws in. It holds, then loops, through the page's one rAF scheduler, so it stops off
// screen, in a hidden tab and with motion off. Reduced motion (or no JS) shows the finished run.
// No hashes and no copy buttons.
import { loop, onMotion, motionOn } from './motion.ts';
import { runAt } from '../lib/timing.ts';

export function mountProof(run: HTMLElement): void {
  const blocks = [...run.querySelectorAll<HTMLElement>('[data-blocks] li')];
  const receipts = [...run.querySelectorAll<HTMLElement>('[data-rc-block]')];
  const n = blocks.length;
  if (!n) return;
  const first = Number(blocks[0].dataset.b);
  let shown = '';

  function paint(head: number, bracket: boolean) {
    const key = `${head}:${bracket}`;
    if (key === shown) return;
    shown = key;
    blocks.forEach((li, k) => {
      li.dataset.reached = k <= head ? 'y' : 'n';
      li.dataset.head = k === head && head < n - 1 ? 'y' : 'n';
    });
    receipts.forEach((r) => (r.dataset.reached = Number(r.dataset.rcBlock) <= first + head ? 'y' : 'n'));
    run.dataset.bracket = bracket ? 'on' : 'off';
  }
  const end = () => paint(n - 1, true);

  let t = 0;
  const handle = loop('proof-run', run, (dt) => {
    t += dt;
    const s = runAt(t, n);
    paint(s.head, s.bracket);
  });
  if (motionOn()) {
    paint(0, false);
    handle.start();
  } else end();
  onMotion((on) => {
    if (on) handle.start();
    else end();
  });
}
