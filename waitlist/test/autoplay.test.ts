// node --test with fake timers: the hero autoplay scheduler (src/lib/timing.ts). A wick runs once per period
// while nothing blocks it; input pauses it until AUTO_RESUME_S of quiet; off-screen, a hidden tab and reduced
// motion each stop it; a run that cannot start is retried.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoplay, AUTO, AUTO_PERIOD_S, AUTO_RESUME_S, AUTO_RETRY_S, AUTO_LEAD_S, INTRO_DIVE_S } from '../src/lib/timing.ts';

const S = 1000;

function setup(fireResult: () => boolean = () => true) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const runs: number[] = [];
  const ap = createAutoplay(() => {
    const ok = fireResult();
    if (ok) runs.push(Date.now());
    return ok;
  });
  return { ap, runs, tick: (s: number) => mock.timers.tick(s * S) };
}

test('constants: a touch every 6-8 s, resume after 8-10 s idle, the touch lands after the lead-in and dive', () => {
  assert.ok(AUTO_PERIOD_S >= 6 && AUTO_PERIOD_S <= 8);
  assert.ok(AUTO_RESUME_S >= 8 && AUTO_RESUME_S <= 10);
  assert.ok(Math.abs(AUTO.touch - AUTO_LEAD_S - INTRO_DIVE_S) < 1e-9);
  // a run ends before the next one is due, so the calm phase is real
  assert.ok(AUTO.end < AUTO_PERIOD_S, `run ${AUTO.end} s vs period ${AUTO_PERIOD_S} s`);
});

test('runs in a loop once unblocked: one run per period', () => {
  const { ap, runs, tick } = setup();
  try {
    ap.block('intro');
    tick(30);
    assert.equal(runs.length, 0, 'nothing while the intro blocks');
    ap.unblock('intro');
    tick(AUTO_PERIOD_S - 0.01);
    assert.equal(runs.length, 0, 'calm phase first');
    tick(0.02);
    assert.equal(runs.length, 1);
    for (let i = 0; i < 3; i++) tick(AUTO_PERIOD_S);
    assert.equal(runs.length, 4);
    for (let i = 1; i < runs.length; i++) assert.equal(runs[i] - runs[i - 1], AUTO_PERIOD_S * S);
  } finally {
    mock.timers.reset();
  }
});

test('input pauses autoplay, and it resumes after AUTO_RESUME_S without input', () => {
  const { ap, runs, tick } = setup();
  try {
    ap.block('x');
    ap.unblock('x');
    tick(AUTO_PERIOD_S - 1);
    ap.input();
    tick(AUTO_RESUME_S - 1);
    assert.equal(runs.length, 0, 'held off while the visitor is active');
    ap.input(); // more input restarts the quiet period
    tick(AUTO_RESUME_S - 0.01);
    assert.equal(runs.length, 0);
    tick(0.02);
    assert.equal(runs.length, 1, 'resumed after quiet');
    tick(AUTO_PERIOD_S);
    assert.equal(runs.length, 2, 'and loops again');
  } finally {
    mock.timers.reset();
  }
});

test('off-screen, hidden tab and reduced motion each stop it; all must lift before it runs again', () => {
  const { ap, runs, tick } = setup();
  try {
    ap.block('start');
    ap.unblock('start');
    tick(AUTO_PERIOD_S);
    assert.equal(runs.length, 1);
    ap.block('offscreen');
    ap.block('hidden');
    assert.equal(ap.armed, false);
    tick(60);
    assert.equal(runs.length, 1);
    ap.unblock('offscreen');
    tick(60);
    assert.equal(runs.length, 1, 'still hidden');
    ap.unblock('hidden');
    assert.equal(ap.armed, true);
    tick(AUTO_PERIOD_S);
    assert.equal(runs.length, 2, 'a calm period after the last block lifts');
    ap.block('motion'); // prefers-reduced-motion: no autoplay at all
    tick(600);
    assert.equal(runs.length, 2);
    assert.deepEqual(ap.blocked, ['motion']);
    ap.unblock('not-a-block'); // lifting something that never blocked changes nothing
    assert.equal(ap.armed, false);
  } finally {
    mock.timers.reset();
  }
});

test('input while blocked: unblocking still honours the quiet period', () => {
  const { ap, runs, tick } = setup();
  try {
    ap.block('offscreen');
    ap.input();
    tick(1);
    ap.unblock('offscreen');
    tick(AUTO_RESUME_S - 1 - 0.01);
    assert.equal(runs.length, 0, 'not before the quiet period ends');
    tick(AUTO_PERIOD_S);
    assert.equal(runs.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('a run that cannot start (mid-pull, payout in the air) is retried after AUTO_RETRY_S', () => {
  let busy = true;
  const { ap, runs, tick } = setup(() => !busy);
  try {
    ap.block('i');
    ap.unblock('i');
    tick(AUTO_PERIOD_S);
    assert.equal(runs.length, 0);
    tick(AUTO_RETRY_S * 3);
    assert.equal(runs.length, 0);
    busy = false;
    tick(AUTO_RETRY_S);
    assert.equal(runs.length, 1);
  } finally {
    mock.timers.reset();
  }
});
