// node --test: the precomputed premium grid against the repo's pricing samples (content brief §4b, computed
// with engine/numera_engine/pricing.py), the liquidation helper against the grid, the purchase-check cascade,
// and the drift guard on the tail table the grid was built from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { estimate, premiumDollars, liqPrice, defaultLevel, GRID_META, DURATIONS, SIGMAS, type Setup } from '../src/lib/pricing.ts';
import { cascadeFull } from '../src/lib/cascade.ts';

const H1 = 3600;
const D1 = 86400;
const D7 = 604800;
const s = (side: 'long' | 'short', lev: number, dur: number, sigma = 0.4): Setup => ({ side, lev, dur, sigma, maxLev: 40 });
const dollars = (side: 'long' | 'short', lev: number, dur: number) => {
  const e = estimate(s(side, lev, dur));
  assert.equal(e.refusal, null, `${side} ${lev}x ${dur}`);
  return e.premium! / 1e6;
};
const near = (a: number, b: number, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol + 1e-9, `${a} vs ${b}`);

test('grid covers the hero inputs: 1h 4h 1d 3d 7d, sigma 32/40/50 %, BTC 40x', () => {
  assert.deepEqual(DURATIONS, [3600, 14400, 86400, 259200, 604800]);
  assert.deepEqual(SIGMAS, [0.32, 0.4, 0.5]);
  assert.equal(GRID_META.theta, 0.2);
  assert.equal(GRID_META.fee, 0);
  assert.equal(GRID_META.level_distance_bps, 56);
  assert.equal(GRID_META.min_premium_bps, 20);
});

test('10x long: liquidation 8.86 % / level 7.95 %; sigma 40: 1h $0.20 floor, 1d $2.43, 7d $25.11', () => {
  const e = estimate(s('long', 10, D1));
  near(e.liqDist * 100, 8.86, 0.005);
  near(e.lvlDist * 100, 7.95, 0.005);
  const h = estimate(s('long', 10, H1));
  assert.equal(h.premium, 200_000);
  assert.equal(h.floorApplied, true);
  near(dollars('long', 10, D1), 2.43);
  near(dollars('long', 10, D7), 25.11);
  near(premiumDollars(estimate(s('long', 10, D1)).premium!), 2.43); // displayed, rounded up to the cent
});

test('5x long: 18.99 / 18.18; 1h floor, 1d $0.43, 7d $8.16', () => {
  const e = estimate(s('long', 5, D1));
  near(e.liqDist * 100, 18.99, 0.005);
  near(e.lvlDist * 100, 18.18, 0.005);
  assert.equal(estimate(s('long', 5, H1)).floorApplied, true);
  near(dollars('long', 5, D1), 0.43);
  near(dollars('long', 5, D7), 8.16);
});

test('10x short: 8.64 / 7.56; 1h floor, 1d $2.49, 7d $28.16', () => {
  const e = estimate(s('short', 10, D1));
  near(e.liqDist * 100, 8.64, 0.005);
  near(e.lvlDist * 100, 7.56, 0.005);
  assert.equal(estimate(s('short', 10, H1)).floorApplied, true);
  near(dollars('short', 10, D1), 2.49);
  near(dollars('short', 10, D7), 28.16);
});

test('20x long: 3.80 / 2.84; 1h floor, 1d $22.26, 7d refused prob_too_high', () => {
  const e = estimate(s('long', 20, D1));
  near(e.liqDist * 100, 3.8, 0.005);
  near(e.lvlDist * 100, 2.84, 0.005);
  assert.equal(estimate(s('long', 20, H1)).floorApplied, true);
  near(dollars('long', 20, D1), 22.26);
  const r = estimate(s('long', 20, D7));
  assert.equal(r.refusal, 'prob_too_high');
  assert.equal(r.premium, null);
});

test('25x long: 2.78 / 1.81; 1h $0.75, 1d $46.29, 7d refused prob_too_high', () => {
  const e = estimate(s('long', 25, D1));
  near(e.liqDist * 100, 2.78, 0.005);
  near(e.lvlDist * 100, 1.81, 0.005);
  near(dollars('long', 25, H1), 0.75);
  near(dollars('long', 25, D1), 46.29);
  assert.equal(estimate(s('long', 25, D7)).refusal, 'prob_too_high');
});

test('40x long: level_too_close for every duration and volatility (testnet minimum 0.56 %)', () => {
  for (const dur of DURATIONS) for (const sg of SIGMAS) assert.equal(estimate(s('long', 40, dur, sg)).refusal, 'level_too_close');
});

test('premiums are never below the v2 floor and the floor flag is consistent', () => {
  for (const side of ['long', 'short'] as const)
    for (let lev = 2; lev <= 40; lev++)
      for (const dur of DURATIONS)
        for (const sg of SIGMAS) {
          const e = estimate(s(side, lev, dur, sg));
          if (e.premium === null) continue;
          assert.ok(e.premium >= 200_000);
          if (e.floorApplied) assert.equal(e.premium, 200_000);
        }
});

test('liquidation helper reproduces the grid distances (entry = spot)', () => {
  for (const side of ['long', 'short'] as const)
    for (let lev = 2; lev <= 40; lev++) {
      const e = estimate(s(side, lev, D1));
      const liq = liqPrice(100, lev, 40, side);
      const lvl = defaultLevel(liq, side);
      near(Math.abs(liq / 100 - 1), e.liqDist, 1e-5);
      near(Math.abs(lvl / 100 - 1), e.lvlDist, 1e-5);
    }
});

test('purchase-check cascade: default passes; 40x stops at level distance; 20x 7d stops at the engine', () => {
  const ok = cascadeFull(s('long', 10, D1), estimate(s('long', 10, D1)));
  assert.equal(ok.stopped, false);
  assert.ok(ok.rows.every((r) => r.state === 'pass' || r.state === 'chain'));
  assert.deepEqual(
    ok.rows.filter((r) => r.state === 'chain').map((r) => r.id),
    ['sig', 'spot', 'position', 'capacity', 'throttle'],
  );
  const close = cascadeFull(s('long', 40, D1), estimate(s('long', 40, D1)));
  assert.equal(close.stopped, true);
  const i = close.rows.findIndex((r) => r.state === 'fail');
  assert.equal(close.rows[i].id, 'distance');
  assert.ok(close.rows.slice(i + 1).every((r) => r.state === 'skip'));
  const hot = cascadeFull(s('long', 20, D7), estimate(s('long', 20, D7)));
  assert.equal(hot.engineRefused, true);
  assert.ok(hot.rows.every((r) => r.state === 'skip'));
});

test('drift guard: the copied tail table equals the engine report and the grid was built from it', () => {
  const sha = (p: string) => createHash('sha256').update(readFileSync(new URL(p, import.meta.url))).digest('hex');
  const copied = sha('../src/data/tail_multipliers.json');
  assert.equal(copied, sha('../../engine/reports/tail_multipliers.json'));
  assert.equal(copied, GRID_META.tail_sha256);
});
