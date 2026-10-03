// node --test: the hero motion timing. The intro holds the mark still before the morph, the morph is slow
// enough to follow, and the scripted wick lands exactly on the level after the morph has finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTRO, INTRO_HOLD_S, INTRO_MORPH_S, INTRO_DIVE_S, wickU } from '../src/lib/timing.ts';

test('intro: the mark holds 0.8-1 s, morphs over 1.5-2 s, total 2.5-3 s', () => {
  assert.ok(INTRO_HOLD_S >= 0.8 && INTRO_HOLD_S <= 1, `hold ${INTRO_HOLD_S}`);
  assert.ok(INTRO_MORPH_S >= 1.5 && INTRO_MORPH_S <= 2, `morph ${INTRO_MORPH_S}`);
  assert.ok(INTRO.morph1 >= 2.5 && INTRO.morph1 <= 3, `hold + morph ${INTRO.morph1}`);
  assert.equal(INTRO.morph0, INTRO_HOLD_S);
});

test('intro: events run in order, and the wick starts only after the morph has finished', () => {
  const order = [INTRO.morph0, INTRO.lines0, INTRO.path0, INTRO.morph1, INTRO.dive0, INTRO.touch, INTRO.hold, INTRO.paid, INTRO.chip, INTRO.end];
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], `step ${i}: ${order[i - 1]} -> ${order[i]}`);
  assert.ok(Math.abs(INTRO.touch - INTRO.dive0 - INTRO_DIVE_S) < 1e-9);
});

test('wickU: base before the dive, exactly 1 on the touch, back near base after a second', () => {
  const base = -0.05;
  assert.equal(wickU(-0.5, base), base);
  assert.equal(wickU(0, base), base);
  assert.equal(wickU(INTRO_DIVE_S, base), 1);
  assert.equal(wickU(INTRO_DIVE_S + 0.04, base), 1);
  assert.ok(wickU(INTRO_DIVE_S / 2, base) < 1);
  assert.ok(Math.abs(wickU(INTRO_DIVE_S + 2, base) - base) < 0.01);
});

test('proof run: the playhead sweeps the 8 blocks in order, then the bracket, then holds and loops', async () => {
  const { runAt, runPeriod, RUN_STEP_S, RUN_BRACKET_S, RUN_HOLD_S } = await import('../src/lib/timing.ts');
  const n = 8; // blocks 484-491 of the recorded run
  assert.deepEqual(runAt(0, n), { head: 0, bracket: false });
  const heads: number[] = [];
  for (let k = 0; k < n; k++) heads.push(runAt(k * RUN_STEP_S + 0.01, n).head);
  assert.deepEqual(heads, [0, 1, 2, 3, 4, 5, 6, 7]);
  // the head reaches the trigger block before the bracket draws
  assert.equal(runAt((n - 1) * RUN_STEP_S + 0.01, n).bracket, false);
  assert.deepEqual(runAt((n - 1) * RUN_STEP_S + RUN_BRACKET_S + 0.01, n), { head: 7, bracket: true });
  // held through the hold, then the loop restarts at block 0
  assert.ok(RUN_HOLD_S >= 3);
  assert.deepEqual(runAt(runPeriod(n) - 0.01, n), { head: 7, bracket: true });
  assert.deepEqual(runAt(runPeriod(n) + 0.01, n), { head: 0, bracket: false });
});
