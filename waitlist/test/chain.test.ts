// The browser-side chain reads: the contract they must keep.
// node --test: the browser RPC reads behind the stats strip (fake fetch; no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPoolStats, decodeUint, formatUsdc, SEL } from '../src/lib/chain.ts';

const POOL = '0x493c14a92da0905b06a91a1e87a75d4bff75e4a6';
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

type Handler = (method: string, params: unknown[]) => unknown;
function fakeFetch(byUrl: Record<string, Handler | 'down'>) {
  const calls: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const h = byUrl[url];
    const { method, params } = JSON.parse(init.body as string);
    calls.push(`${url} ${method}`);
    if (!h || h === 'down') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: h(method, params) }));
  }) as unknown as typeof fetch;
  return { f, calls };
}
const healthy =
  (chain = '0x3e6'): Handler =>
  (method, params) => {
    if (method === 'eth_chainId') return chain;
    const { to, data } = (params as [{ to: string; data: string }])[0];
    assert.equal(to, POOL);
    if (data === SEL.totalAssets) return word(1_971_242_676n);
    if (data === SEL.coverCount) return word(3n);
    throw new Error('unexpected call');
  };

test('selectors are the 4-byte ids of totalAssets() and coverCount()', () => {
  assert.equal(SEL.totalAssets, '0x01e1d114');
  assert.equal(SEL.coverCount, '0xfeb0b8f5');
});

test('decodeUint / formatUsdc (6 decimals, two shown, never rounded up)', () => {
  assert.equal(decodeUint(word(5n)), 5n);
  assert.equal(decodeUint('0x'), null);
  assert.equal(decodeUint('0x12'), null);
  assert.equal(formatUsdc(1_971_242_676n), '1,971.24');
  assert.equal(formatUsdc(999_999n), '0.99');
  assert.equal(formatUsdc(0n), '0.00');
});

test('reads both values from the first endpoint on chain 998', async () => {
  const { f, calls } = fakeFetch({ a: healthy(), b: healthy() });
  const s = await readPoolStats(['a', 'b'], 998, POOL, f);
  assert.deepEqual(s, { totalAssets: 1_971_242_676n, coverCount: 3n });
  assert.ok(calls.every((c) => c.startsWith('a ')));
});

test('falls back when the first endpoint is down or on the wrong chain', async () => {
  const down = fakeFetch({ a: 'down', b: healthy() });
  assert.equal((await readPoolStats(['a', 'b'], 998, POOL, down.f)).coverCount, 3n);
  const wrong = fakeFetch({ a: healthy('0x3e7'), b: healthy() }); // 999 = mainnet
  assert.equal((await readPoolStats(['a', 'b'], 998, POOL, wrong.f)).coverCount, 3n);
  assert.ok(!wrong.calls.some((c) => c === 'a eth_call'));
});

test('every endpoint failing gives nulls (the page shows a dash, never a number)', async () => {
  const { f } = fakeFetch({ a: 'down', b: healthy('0x1') });
  assert.deepEqual(await readPoolStats(['a', 'b'], 998, POOL, f), { totalAssets: null, coverCount: null });
  const bad = fakeFetch({ a: (m) => (m === 'eth_chainId' ? '0x3e6' : 'not-hex') });
  assert.deepEqual(await readPoolStats(['a'], 998, POOL, bad.f), { totalAssets: null, coverCount: null });
});
