// S2 wick lanes: play once on entry (time-based), a shared scrubber and Replay. Travel may be scrubbed; the
// events (stop fill, touch, payout) are positions on the one time axis, so they never depend on scroll speed.
import { laneSvg, type LaneId, type LaneLabels } from '../lib/lanes.ts';
import { loop, motionOn, onMotion, onceVisible } from './motion.ts';

const PLAY_S = 5.2;

export function mountLanes(root: HTMLElement): void {
  const svgs = [...root.querySelectorAll<SVGSVGElement>('[data-lane]')];
  const scrub = root.querySelector<HTMLInputElement>('[data-lanes-scrub]')!;
  const replay = root.querySelector<HTMLButtonElement>('[data-lanes-replay]')!;
  const lb = JSON.parse(root.dataset.labels ?? '{}') as LaneLabels;
  let t = 1;
  let playing = false;
  let t0 = 0;

  function render() {
    for (const s of svgs) {
      const r = s.getBoundingClientRect();
      const w = Math.max(200, Math.round(r.width));
      const h = Math.max(80, Math.round(r.height));
      s.setAttribute('viewBox', `0 0 ${w} ${h}`);
      s.innerHTML = laneSvg(s.dataset.lane as LaneId, t, w, h, lb);
    }
    scrub.value = String(Math.round(t * 1000));
    scrub.setAttribute('aria-valuetext', t >= 1 ? 'end of the wick' : `${Math.round(t * 100)} % through the wick`);
  }
  const run = loop('lanes', root, (_dt, now) => {
    if (!playing) return false;
    t = Math.min(1, (now - t0) / 1000 / PLAY_S);
    render();
    if (t >= 1) {
      playing = false;
      return false;
    }
  });
  function play() {
    if (!motionOn()) {
      t = 1;
      render();
      return;
    }
    t = 0;
    t0 = performance.now();
    playing = true;
    render();
    run.start();
  }
  scrub.addEventListener('input', () => {
    playing = false;
    run.stop();
    t = Number(scrub.value) / 1000;
    render();
  });
  replay.addEventListener('click', play);
  onMotion((on) => {
    if (!on && playing) {
      playing = false;
      t = 1;
      render();
    }
  });
  new ResizeObserver(() => render()).observe(root);
  render();
  onceVisible(root, play, 0.35);
}
