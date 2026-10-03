// Hero motion timing: every duration a visitor can see in the intro (and, below, the autoplay loop) as a named
// constant, so the timing can be tuned in one place. Pure module: no DOM, so node tests import it directly.

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeIn = (t: number) => t * t * t;

// ---- intro (seconds) ---------------------------------------------------------------------------------------
/** The mark holds still this long before it moves, so a visitor sees the logo first. */
export const INTRO_HOLD_S = 0.9;
/** Then the mark's two polygons part and fold flat into the liquidation line and the level over this long. */
export const INTRO_MORPH_S = 1.8;
/** The price path draws in over this long, starting late in the morph. */
export const INTRO_PATH_S = 0.85;
/** The scripted wick's dive from the path to the level. */
export const INTRO_DIVE_S = 0.62;
/** Everything else follows from the constants above (the shares keep the original choreography). */
export const INTRO = (() => {
  const morph1 = INTRO_HOLD_S + INTRO_MORPH_S;
  const lines0 = INTRO_HOLD_S + 0.6 * INTRO_MORPH_S; // the lines fade in under the last 40 % of the fold
  const path0 = INTRO_HOLD_S + 0.82 * INTRO_MORPH_S;
  const dive0 = path0 + INTRO_PATH_S + 0.1;
  const touch = dive0 + INTRO_DIVE_S;
  return { morph0: INTRO_HOLD_S, morph1, lines0, path0, dive0, touch, hold: touch + 0.08, paid: touch + 0.23, chip: touch + 0.36, end: touch + 1.68 };
})();

/** A scripted wick's head, `t` seconds after its dive starts: an ease-in dive to the level (u = 1), an 80 ms
 *  hold on it, then a critically damped return to `base`. Before the dive the head sits at `base`. */
export function wickU(t: number, base: number): number {
  if (t < 0) return base;
  if (t < INTRO_DIVE_S) return lerp(base, 1, easeIn(t / INTRO_DIVE_S));
  if (t < INTRO_DIVE_S + 0.08) return 1;
  const tau = t - INTRO_DIVE_S - 0.08;
  return base + (1 - base) * Math.exp(-5.5 * tau) * (1 + 5.5 * tau);
}

