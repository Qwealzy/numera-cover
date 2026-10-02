// One rAF scheduler for every animation loop on the page (build spec 2.8).
// A loop runs only while it wants frames, its element is on screen, the tab is visible and motion is on.
// The number of running loops is written to <html data-loops="N"> so it can be observed from outside.

export type Tick = (dt: number, now: number) => boolean | void; // return false: nothing left to animate

type Loop = { name: string; tick: Tick; want: boolean; visible: boolean };

const html = document.documentElement;
const loops: Loop[] = [];
let raf = 0;
let last = 0;
let docVisible = document.visibilityState === 'visible';
const motionListeners: ((on: boolean) => void)[] = [];

export function motionOn(): boolean {
  return html.dataset.motion === 'on';
}

export function setMotion(on: boolean, persist = true): void {
  html.dataset.motion = on ? 'on' : 'off';
  if (persist) {
    try {
      window.localStorage.setItem('numera-motion', on ? 'on' : 'off');
    } catch {
      // storage blocked: the setting lasts for this page view only
    }
  }
  for (const f of motionListeners) f(on);
  pump();
}
export function onMotion(f: (on: boolean) => void): void {
  motionListeners.push(f);
}

const running = (l: Loop) => l.want && l.visible && docVisible && motionOn();

function frame(now: number) {
  raf = 0;
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
  last = now;
  let n = 0;
  for (const l of loops) {
    if (!running(l)) continue;
    if (l.tick(dt, now) === false) l.want = false;
    else n++;
  }
  html.dataset.loops = String(n);
  if (n > 0) raf = requestAnimationFrame(frame);
  else last = 0;
}

function pump() {
  const n = loops.filter(running).length;
  html.dataset.loops = String(n);
  if (n > 0 && !raf) {
    last = 0;
    raf = requestAnimationFrame(frame);
  } else if (n === 0 && raf) {
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
  }
}

export type LoopHandle = { start(): void; stop(): void; readonly active: boolean };

/** Registers a loop tied to an element's visibility. It starts idle; call start() to request frames. */
export function loop(name: string, el: Element, tick: Tick, threshold = 0): LoopHandle {
  const l: Loop = { name, tick, want: false, visible: false };
  loops.push(l);
  new IntersectionObserver(
    (entries) => {
      for (const e of entries) l.visible = e.isIntersecting;
      pump();
    },
    { threshold },
  ).observe(el);
  return {
    start() {
      l.want = true;
      pump();
    },
    stop() {
      l.want = false;
      pump();
    },
    get active() {
      return running(l);
    },
  };
}

document.addEventListener('visibilitychange', () => {
  docVisible = document.visibilityState === 'visible';
  pump();
});
html.dataset.loops = '0';

/** Calls `f` once when `el` is about `ratio` visible (section reveals, plays on entry). */
export function onceVisible(el: Element, f: () => void, ratio = 0.35): void {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          io.disconnect();
          f();
        }
    },
    { threshold: ratio },
  );
  io.observe(el);
}

// ---- small math helpers shared by the scenes ----
export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const expoOut = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const easeIn = (t: number) => t * t * t;
export const smooth = (t: number) => t * t * (3 - 2 * t);

/** Critically-damped-ish spring step (semi-implicit Euler). Mutates and returns the state. */
export function spring(s: { x: number; v: number }, target: number, dt: number, k = 260, c = 22) {
  const a = -k * (s.x - target) - c * s.v;
  s.v += a * dt;
  s.x += s.v * dt;
  return s;
}
