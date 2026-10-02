// node --test: the v2 additions to the copied chain reads (ledger, oracle price) and the shared geometry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLedger, readOraclePx6, callData, decodeBool, SEL2, utcTime } from '../src/lib/chain.ts';
import { labelTops, wickAt, firstCross, WICK_LOW_T, layout, distAt } from '../src/lib/geometry.ts';
import { LANE_EVENTS } from '../src/lib/lanes.ts';

const POOL = '0x493c14a92da0905b06a91a1e87a75d4bff75e4a6';
const SRC = '0xBae5a5175698EaBe85703f1676bA598f96caA5FF';
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
type H = (method: string, params: unknown[]) => unknown;
function fakeFetch(byUrl: Record<string, H | 'down'>) {
  const calls: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const h = byUrl[url];
    const { method, params } = JSON.parse(init.body as string);
    calls.push(`${url} ${method} ${(params?.[0] as { data?: string })?.data ?? ''}`);
    if (!h || h === 'down') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: h(method, params) }));
  }) as unknown as typeof fetch;
  return { f, calls };
}
const chain998 = (rest: H): H => (m, p) => (m === 'eth_chainId' ? '0x3e6' : rest(m, p));

test('selectors and uint32 encoding', () => {
  assert.equal(SEL2.lockedAssets, '0x274fc72a');
  assert.equal(SEL2.freeAssets, '0x11f240ac');
  assert.equal(SEL2.paused, '0x5c975abb');
  assert.equal(SEL2.oraclePx6, '0xb1d42205');
  assert.equal(callData(SEL2.oraclePx6, 3), '0xb1d42205' + '0'.repeat(63) + '3');
  assert.equal(callData(SEL2.oraclePx6, 135).slice(-2), '87');
  assert.throws(() => callData(SEL2.oraclePx6, -1));
  assert.equal(decodeBool(word(0n)), false);
  assert.equal(decodeBool(word(1n)), true);
  assert.equal(decodeBool(word(2n)), null);
  assert.equal(utcTime(new Date(Date.UTC(2026, 9, 2, 19, 28, 3))), '19:28:03');
});

test('readLedger: five fields from the first healthy endpoint; a failed field stays null', async () => {
  const values: Record<string, string> = {
    [SEL2.totalAssets]: word(1_971_242_676n),
    [SEL2.freeAssets]: word(1_971_242_676n),
    [SEL2.lockedAssets]: word(0n),
    [SEL2.coverCount]: word(3n),
  };
  const { f } = fakeFetch({
    a: 'down',
    b: chain998((_m, p) => {
      const { to, data } = (p as [{ to: string; data: string }])[0];
      assert.equal(to, POOL);
      if (data === SEL2.paused) return 'not-hex';
      return values[data];
    }),
  });
  assert.deepEqual(await readLedger(['a', 'b'], 998, POOL, f), {
    totalAssets: 1_971_242_676n,
    freeAssets: 1_971_242_676n,
    lockedAssets: 0n,
    coverCount: 3n,
    paused: null,
  });
});

test('readLedger: wrong chain everywhere gives all nulls (the page shows dashes)', async () => {
  const { f } = fakeFetch({ a: () => '0x3e7', b: 'down' });
  assert.deepEqual(await readLedger(['a', 'b'], 998, POOL, f), {
    totalAssets: null,
    freeAssets: null,
    lockedAssets: null,
    coverCount: null,
    paused: null,
  });
});

test('readOraclePx6: reads the price source with the perp index; failure and zero are null', async () => {
  const ok = fakeFetch({
    a: chain998((_m, p) => {
      const { to, data } = (p as [{ to: string; data: string }])[0];
      assert.equal(to, SRC);
      assert.equal(data, callData(SEL2.oraclePx6, 3));
      return word(84_366_000_000n);
    }),
  });
  assert.equal(await readOraclePx6(['a'], 998, SRC, 3, ok.f), 84_366_000_000n);
  const zero = fakeFetch({ a: chain998(() => word(0n)) });
  assert.equal(await readOraclePx6(['a'], 998, SRC, 3, zero.f), null);
  const down = fakeFetch({ a: 'down' });
  assert.equal(await readOraclePx6(['a'], 998, SRC, 3, down.f), null);
});

test('the answering endpoint is remembered: later reads skip the chain check; a failure there re-picks', async () => {
  let bDown = false;
  const { f, calls } = fakeFetch({
    a: 'down',
    b: (m, p) => {
      if (bDown) throw new Error('b went down');
      return chain998(() => word(84_366_000_000n))(m, p);
    },
    c: chain998(() => word(84_400_000_000n)),
  });
  assert.equal(await readOraclePx6(['a', 'b', 'c'], 998, SRC, 3, f), 84_366_000_000n);
  const first = calls.length;
  assert.equal(await readOraclePx6(['a', 'b', 'c'], 998, SRC, 3, f), 84_366_000_000n);
  // second read: one eth_call on b, no eth_chainId and no try on a
  assert.deepEqual(calls.slice(first).map((c) => c.split(' ').slice(0, 2).join(' ')), ['b eth_call']);
  bDown = true;
  const before = calls.length;
  assert.equal(await readOraclePx6(['a', 'b', 'c'], 998, SRC, 3, f), 84_400_000_000n);
  // b failed: re-picked with the chain check, the failed endpoint last (a, then c answers)
  const after = calls.slice(before).map((c) => c.split(' ').slice(0, 2).join(' '));
  assert.deepEqual(after.slice(0, 2), ['b eth_call', 'a eth_chainId']);
  assert.ok(after.includes('c eth_chainId') && after.at(-1) === 'c eth_call');
});

test('instrument labels never overlap, even at 40x where the lines are a few px apart', () => {
  for (const dir of [1, -1] as const)
    for (const [e, l, q] of [
      [150, 160, 166],
      [150, 290, 320],
      [390, 380, 375],
    ]) {
      const t = labelTops(e, dir === 1 ? l : 2 * e - l, dir === 1 ? q : 2 * e - q, dir, 16);
      const ys = [t.entry, t.level, t.liq].sort((a, b) => a - b);
      assert.ok(ys[1] - ys[0] >= 16 && ys[2] - ys[1] >= 16, JSON.stringify(t));
    }
});

test('soft distance map round-trips (pulling the price reads back the right %)', () => {
  const L = layout(800, 500, 0.0886, 0.0795, 'long');
  for (const y of [L.entryY, L.levelY, L.liqY]) assert.ok(Number.isFinite(distAt(L, y)));
  assert.ok(Math.abs(distAt(L, L.levelY) - 0.0795) < 1e-9);
  assert.ok(Math.abs(distAt(L, L.liqY) - 0.0886) < 1e-9);
});

test('scripted wick: one low at -1; the cover lane touches before the low; the stop is crossed before the fill', () => {
  assert.ok(Math.abs(wickAt(WICK_LOW_T) + 1) < 1e-9);
  assert.ok(LANE_EVENTS.stopCross < LANE_EVENTS.coverTouch && LANE_EVENTS.coverTouch <= LANE_EVENTS.low);
  assert.equal(firstCross(-1.16), null); // the lanes' liquidation line is never reached
  assert.ok(wickAt(1) > 0); // the price came back
});
