// S5 reservation toy (SIM, a toy pool, not the live pool): selling locks a payout block before its premium
// counts; at the 80 % cap the next sale is refused and says why; settling frees or pays the block.
// Capacity is shown only in % and blocks; no dollar amounts, no rates.
import { underwriters as U } from '../copy/en.ts';
import { motionOn } from './motion.ts';

const CAP_BLOCKS = 8; // 80 % of 10 (deployments/testnet-v2.json maxUtilizationBps 8000)

export function mountToy(root: HTMLElement): void {
  const T = U.toy;
  const slots = [...root.querySelectorAll<HTMLElement>('.slot')];
  const cap = root.querySelector<HTMLElement>('[data-cap]')!;
  const tray = root.querySelector<HTMLElement>('[data-tray]')!;
  const meter = root.querySelector<HTMLElement>('[data-toy-meter]')!;
  const say = root.querySelector<HTMLElement>('[data-toy-say]')!;
  const btn = (k: string) => root.querySelector<HTMLButtonElement>(`[data-toy-act="${k}"]`)!;
  let locked = 0;
  let chips = 0;
  for (const s of slots) s.addEventListener('animationend', () => s.classList.remove('out', 'drop'));

  const anim = (el: HTMLElement, cls: string) => {
    el.classList.remove(cls);
    if (!motionOn()) return;
    void el.offsetWidth;
    el.classList.add(cls);
  };
  function render(msg: string, tone = '') {
    slots.forEach((s, i) => s.classList.toggle('on', i < locked));
    cap.classList.toggle('shut', locked >= CAP_BLOCKS);
    meter.textContent = T.status(locked);
    say.textContent = msg;
    say.dataset.tone = tone;
  }
  btn('sell').addEventListener('click', () => {
    if (locked >= CAP_BLOCKS) {
      anim(btn('sell'), 'shake');
      anim(cap, 'shut');
      render(T.refused, 'refused');
      return;
    }
    locked++;
    render(T.sold);
    anim(slots[locked - 1], 'drop');
  });
  const settle = (touch: boolean) => {
    if (locked === 0) {
      render(T.empty);
      return;
    }
    const top = slots[locked - 1];
    locked--;
    if (touch) {
      anim(top, 'out');
      render(T.settledTouch);
    } else {
      chips++;
      if (chips <= 12) {
        const c = document.createElement('span');
        c.className = 'chip';
        tray.append(c);
      }
      top.classList.remove('drop');
      render(T.settledNone);
    }
  };
  btn('none').addEventListener('click', () => settle(false));
  btn('touch').addEventListener('click', () => settle(true));
  btn('reset').addEventListener('click', () => {
    locked = 0;
    chips = 0;
    tray.textContent = '';
    slots.forEach((s) => s.classList.remove('drop', 'out'));
    render(T.empty);
  });
  render(T.empty);
}
