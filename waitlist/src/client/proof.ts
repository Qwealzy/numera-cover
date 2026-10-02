// S6 recorded run: on entry the receipts type in once and the playhead walks the block track; Replay and the
// keyboard-movable playhead re-run it. Copy buttons put the full `cast receipt` command on the clipboard.
import { proof as Pf } from '../copy/en.ts';
import { motionOn, onceVisible } from './motion.ts';

export function mountProof(root: HTMLElement): void {
  const run = root.querySelector<HTMLElement>('[data-run]')!;
  const first = Number(run.dataset.first);
  const blocks = [...run.querySelectorAll<HTMLElement>('[data-blocks] li')];
  const receipts = [...run.querySelectorAll<HTMLElement>('[data-rc-block]')];
  const ph = run.querySelector<HTMLInputElement>('[data-run-playhead]')!;
  const out = run.querySelector<HTMLElement>('[data-run-out]')!;
  const replay = run.querySelector<HTMLButtonElement>('[data-run-replay]')!;
  const copied = run.querySelector<HTMLElement>('[data-copied]')!;
  let timer = 0;

  function setHead(i: number) {
    const b = first + i;
    blocks.forEach((li, k) => {
      li.dataset.reached = k <= i ? 'y' : 'n';
      li.dataset.head = k === i ? 'y' : 'n';
    });
    receipts.forEach((r) => (r.dataset.reached = Number(r.dataset.rcBlock) <= b ? 'y' : 'n'));
    ph.value = String(i);
    out.textContent = b.toLocaleString('en-US');
    ph.setAttribute('aria-valuetext', `block ${b.toLocaleString('en-US')}`);
  }
  function play() {
    clearInterval(timer);
    const lastI = blocks.length - 1;
    if (!motionOn()) {
      setHead(lastI);
      return;
    }
    run.classList.remove('typing');
    void run.offsetWidth;
    run.classList.add('typing');
    let i = 0;
    setHead(0);
    timer = window.setInterval(() => {
      i++;
      setHead(i);
      if (i >= lastI) clearInterval(timer);
    }, 330);
  }
  ph.addEventListener('input', () => {
    clearInterval(timer);
    setHead(Number(ph.value));
  });
  replay.addEventListener('click', play);
  setHead(blocks.length - 1);
  onceVisible(run, play, 0.35);

  for (const b of run.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    b.addEventListener('click', async () => {
      const text = b.dataset.copy ?? '';
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        ok = false;
      }
      copied.textContent = ok ? `${Pf.copied}: ${text}` : Pf.copyFailed;
      b.textContent = ok ? Pf.copied : Pf.copy;
      window.setTimeout(() => (b.textContent = Pf.copy), 1800);
    });
  }
}
