// Every page: marks the page script as booted, the nav backdrop after 8 px, and the Motion toggle
// (remembered per viewer in localStorage; every read and write is wrapped, the page works without it).
// The toggle's accessible name is fixed ("Motion"); its state is aria-pressed. The on/off word is visual.
import { nav as N } from '../copy/en.ts';
import { motionOn, setMotion, onMotion } from './motion.ts';

export function bootNav(): void {
  document.documentElement.classList.add('booted');
  const navEl = document.querySelector<HTMLElement>('[data-nav]');
  const onScroll = () => navEl?.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  const toggle = document.querySelector<HTMLButtonElement>('[data-motion-toggle]');
  const stateEl = document.querySelector<HTMLElement>('[data-motion-state]');
  const show = (m: boolean) => {
    toggle?.setAttribute('aria-pressed', String(m));
    if (stateEl) stateEl.textContent = m ? N.motionOn : N.motionOff;
  };
  toggle?.addEventListener('click', () => setMotion(!motionOn()));
  onMotion(show);
  show(motionOn());
}
