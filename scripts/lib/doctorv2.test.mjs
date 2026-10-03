// Unit tests for scripts/lib/doctorv2.mjs (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { V2_SEL, loadV2, v2FileLines, decodeUint, decodeBool, fmtUsdc6, checkV2Pools } from './doctorv2.mjs';

const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const A = '0x493c14a92da0905b06a91a1e87a75d4bff75e4a6';
const B = '0xcb909999bc241b6970134a440001c7b758df2b00';

function tmpJson(obj) {
  const d = mkdtempSync(path.join(tmpdir(), 'doctorv2-'));
  const f = path.join(d, 'testnet-v2.json');
  writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return f;
}

test('selectors match cast sig', () => {
  assert.deepEqual(V2_SEL, { paused: '0x5c975abb', totalAssets: '0x01e1d114', coverCount: '0xfeb0b8f5' });
});

test('missing file is one WARN, not a FAIL', () => {
  const f = path.join(tmpdir(), 'no-such-dir-doctorv2', 'testnet-v2.json');
  const lines = v2FileLines(loadV2(f), f);
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], 'WARN');
});

test('unparsable file is a FAIL', () => {
  const f = tmpJson('{nope');
  assert.equal(v2FileLines(loadV2(f), f)[0][0], 'FAIL');
});

test('reads whatever pool keys exist; mainnet and bad entries fail', () => {
  const f = tmpJson({ chainId: 998, pools: { alpha: { pool: A, chainId: 998 }, beta: { pool: B }, gamma: { pool: 'x' }, delta: { pool: A, chainId: 999 } } });
  const v2 = loadV2(f);
  assert.deepEqual(v2.pools.map((p) => p.name), ['alpha', 'beta', 'delta']);
  const lines = v2FileLines(v2, f);
  assert.equal(lines[0][0], 'OK');
  assert.ok(lines.some(([l, c]) => l === 'FAIL' && c === 'v2 pools.gamma'));
  assert.ok(lines.some(([l, c, d]) => l === 'FAIL' && c === 'v2 pools.delta chainId' && /MAINNET/.test(d)));
  const main = tmpJson({ chainId: 999, pools: {} });
  assert.equal(v2FileLines(loadV2(main), main)[0][0], 'FAIL');
});

test('decoders and USDC formatting', () => {
  assert.equal(decodeUint(word(42)), 42n);
  assert.equal(decodeBool(word(0)), false);
  assert.equal(decodeBool(word(1)), true);
  assert.throws(() => decodeBool(word(2)));
  assert.throws(() => decodeUint('0x'));
  assert.equal(fmtUsdc6(1900000000n), '1900.000000');
  assert.equal(fmtUsdc6(332772n), '0.332772');
  assert.equal(fmtUsdc6(0n), '0.000000');
});

function fakeClient(answers) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      const key = method === 'eth_getCode' ? `code:${params[0]}` : `${params[0].to}:${params[0].data}`;
      const a = answers[key];
      if (a instanceof Error) throw a;
      return { result: a, url: 'https://rpc.test/x' };
    },
  };
}

test('checkV2Pools: all green, only read methods', async () => {
  const c = fakeClient({
    [`code:${A}`]: '0x6080',
    [`${A}:${V2_SEL.paused}`]: word(0),
    [`${A}:${V2_SEL.totalAssets}`]: word(1900000000),
    [`${A}:${V2_SEL.coverCount}`]: word(2),
  });
  const out = [];
  await checkV2Pools(c, [{ name: 'mock', addr: A }], (...l) => out.push(l));
  assert.deepEqual(out.map((l) => [l[0], l[1]]), [
    ['OK', 'v2 code pools.mock'],
    ['OK', 'v2 paused pools.mock'],
    ['OK', 'v2 totalAssets pools.mock'],
    ['OK', 'v2 coverCount pools.mock'],
  ]);
  assert.match(out[2][2], /^1900\.000000 USDC/);
  assert.match(out[3][2], /^2 /);
  assert.ok(c.calls.every(([m]) => m === 'eth_getCode' || m === 'eth_call'));
});

test('checkV2Pools: no code / paused / RPC error each FAIL, and the run continues', async () => {
  const c = fakeClient({
    [`code:${A}`]: '0x',
    [`${A}:${V2_SEL.paused}`]: word(1),
    [`${A}:${V2_SEL.totalAssets}`]: new Error('rpc.test timeout'),
    [`${A}:${V2_SEL.coverCount}`]: word(0),
    [`code:${B}`]: new Error('rpc.test HTTP 503'),
    [`${B}:${V2_SEL.paused}`]: word(0),
    [`${B}:${V2_SEL.totalAssets}`]: word(0),
    [`${B}:${V2_SEL.coverCount}`]: '0x',
  });
  const out = [];
  await checkV2Pools(c, [{ name: 'mock', addr: A }, { name: 'hypercore', addr: B }], (...l) => out.push(l));
  assert.deepEqual(out.map((l) => l[0]), ['FAIL', 'FAIL', 'FAIL', 'OK', 'FAIL', 'OK', 'OK', 'FAIL']);
  assert.match(out[0][2], /NO CODE/);
  assert.match(out[2][2], /timeout/);
});
