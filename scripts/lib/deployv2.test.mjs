import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ANVIL_ACCOUNT0,
  BIG_BLOCK_GAS_LIMIT,
  childEnv,
  decimalToPx6,
  guardianProblem,
  parseSeed,
  forgeArgs,
  hasCode,
  mergeV2,
  verifyRun,
  parseDeployArgs,
  parseLimits,
  perpList,
  standinFromInfo,
  summarizeBroadcast,
} from './deployv2.mjs';

test('parseDeployArgs: defaults, flags, validation', () => {
  assert.deepEqual(parseDeployArgs([]), {
    dryRun: false, fork: false, yes: false, mode: 'hypercore', rpc: null, standinPx: null, gasPrice: null, replace: false, help: false, recordOnly: false, run: null,
  });
  const a = parseDeployArgs(['--dry-run', '--yes', '--mode', 'mock', '--standin-px', '1,2', '--gas-price', '100']);
  assert.equal(a.dryRun, true);
  assert.equal(a.mode, 'mock');
  assert.deepEqual(a.standinPx, ['1', '2']);
  assert.throws(() => parseDeployArgs(['--mode', 'real']), /hypercore or mock/);
  assert.throws(() => parseDeployArgs(['--rpc']), /needs a value/);
  assert.throws(() => parseDeployArgs(['--standin-px', '0,1']), /positive/);
  assert.throws(() => parseDeployArgs(['--broadcast']), /unknown/);
  assert.equal(parseDeployArgs(['--fork', '--yes']).fork, true);
  assert.throws(() => parseDeployArgs(['--fork', '--dry-run']), /exclusive/);
});

test('decimalToPx6: exact, rounding, invalid', () => {
  assert.equal(decimalToPx6('84245.6'), '84245600000');
  assert.equal(decimalToPx6('31.3875'), '31387500');
  assert.equal(decimalToPx6('0.1234565'), '123457');
  assert.equal(decimalToPx6('0.9999995'), '1000000');
  assert.equal(decimalToPx6('150'), '150000000');
  assert.throws(() => decimalToPx6('0'), /non-positive/);
  assert.throws(() => decimalToPx6('-1'), /not a decimal/);
});

test('standinFromInfo: names must match the deployments table', () => {
  const perps = perpList({ BTC: 3, SOL: 0 });
  const universe = [{ name: 'SOL' }, { name: 'A' }, { name: 'B' }, { name: 'BTC' }];
  const ctxs = [{ oraclePx: '150.5' }, {}, {}, { oraclePx: '84000.1' }];
  assert.deepEqual(standinFromInfo([{ universe }, ctxs], perps), ['84000100000', '150500000']);
  assert.throws(() => standinFromInfo([{ universe }, ctxs], perpList({ ETH: 3 })), /deployments says ETH/);
  assert.throws(() => standinFromInfo({}, perps), /unexpected/);
  assert.throws(() => perpList({ BTC: -1 }), /bad perp index/);
});

test('childEnv: .env only in the child, never DEPLOYER_KEY in a dry run', () => {
  const base = { PATH: 'p', DEPLOYER_KEY: 'shell-key' };
  const dot = { DEPLOYER_KEY: 'dotenv-key', OTHER: 'x' };
  const real = childEnv(base, dot, { MODE: 'mock', USDC: undefined, GUARDIAN: '' }, { dryRun: false });
  assert.equal(real.DEPLOYER_KEY, 'dotenv-key');
  assert.equal(real.MODE, 'mock');
  assert.equal('USDC' in real, false);
  assert.equal('GUARDIAN' in real, false);
  assert.equal('OTHER' in real, false, 'only the needed .env values');
  const dry = childEnv(base, dot, {}, { dryRun: true });
  assert.equal('DEPLOYER_KEY' in dry, false);
  assert.equal(base.DEPLOYER_KEY, 'shell-key', 'parent env untouched');
});

test('forgeArgs: skip-simulation, slow and no block gas cap always; key never in argv', () => {
  const real = forgeArgs({ rpc: 'https://r' });
  assert.ok(real.includes('--skip-simulation') && real.includes('--slow') && real.includes('--broadcast'));
  assert.equal(real.some((x) => /key|unlocked/i.test(x)), false);
  // 2026-10-02: without it forge's local pass capped the pool creation at the forked 3M small block (out of gas).
  assert.ok(real.includes('--disable-block-gas-limit'));
  const sol = readFileSync(new URL('../../contracts/script/Deploy.s.sol', import.meta.url), 'utf8');
  const m = /BIG_BLOCK_GAS_LIMIT = ([\d_]+);/.exec(sol);
  assert.equal(Number(m?.[1].replaceAll('_', '')), BIG_BLOCK_GAS_LIMIT, 'must equal Deploy.BIG_BLOCK_GAS_LIMIT');
  const dry = forgeArgs({ rpc: 'http://127.0.0.1:1', unlockedSender: ANVIL_ACCOUNT0, gasPrice: '7' });
  assert.deepEqual(dry.slice(-5), ['--unlocked', '--sender', ANVIL_ACCOUNT0, '--with-gas-price', '7']);
  const pre = forgeArgs({ rpc: 'https://r', broadcast: false });
  assert.equal(pre.includes('--broadcast'), false, 'the preflight never broadcasts');
  assert.ok(pre.includes('--disable-block-gas-limit') && pre.includes('--skip-simulation'));
});

test('hasCode: eth_getCode results', () => {
  assert.equal(hasCode('0x'), false);
  assert.equal(hasCode('0x0'), false);
  assert.equal(hasCode(''), false);
  assert.equal(hasCode(null), false);
  assert.equal(hasCode('0x6080604052'), true);
});

test('summarizeBroadcast: contracts, gas, precompile targets', () => {
  const run = {
    transactions: [
      { hash: '0xa', transactionType: 'CREATE', contractName: 'CoverPool', contractAddress: '0xP', transaction: {} },
      { hash: '0xb', transactionType: 'CALL', contractName: 'X', function: 'f()', transaction: { to: '0x0000000000000000000000000000000000000807' } },
    ],
    receipts: [{ transactionHash: '0xa', gasUsed: '0x10', status: '0x1' }],
  };
  const s = summarizeBroadcast(run);
  assert.equal(s.contracts.CoverPool, '0xP');
  assert.deepEqual(s.precompileTxs, ['0xb']);
  assert.equal(s.txs[0].gasUsed, 16);
  assert.equal(s.txs[1].status, null);
});

test('parseLimits and mergeV2', () => {
  const l = parseLimits(['(8000, 5000, 604800 [6.048e5], 30, 1000000 [1e6], 20, 25, 3600, 2500, 2500, 1500)']);
  assert.equal(l.maxDuration, '604800');
  assert.equal(l.maxPaidPerWindowBps, '1500');
  assert.throws(() => parseLimits(['(1, 2)']), /expected 11/);
  const a = mergeV2(null, 'mock', { pool: '0x1' }, { replace: false });
  assert.equal(a.chainId, 998);
  assert.throws(() => mergeV2(a, 'mock', { pool: '0x2' }, { replace: false }), /--replace/);
  assert.equal(mergeV2(a, 'mock', { pool: '0x2' }, { replace: true }).pools.mock.pool, '0x2');
  assert.equal(mergeV2(a, 'hypercore', { pool: '0x3' }, { replace: false }).pools.mock.pool, '0x1');
});

test('guardianProblem: separate key required (audit L4)', () => {
  const k = '0x9a809EF608F5AE30Ddd26708cC6794bD7dad7a1B';
  const g = '0x1111111111111111111111111111111111111111';
  assert.equal(guardianProblem(998, g, k), null);
  assert.match(guardianProblem(998, k.toLowerCase(), k), /equals the keeper/);
  assert.match(guardianProblem(998, '', k), /GUARDIAN is not set/);
  assert.match(guardianProblem(998, g, ''), /no keeper address/);
  assert.match(guardianProblem(998, 'nope', k), /not an address/);
  assert.equal(guardianProblem(31337, '', k), null, 'local dry run may omit the guardian');
  assert.match(guardianProblem(31337, k, k), /equals the keeper/);
});

test('parseSeed: whole mUSDC or unset (audit L3)', () => {
  assert.equal(parseSeed(undefined), undefined);
  assert.equal(parseSeed(' '), undefined);
  assert.equal(parseSeed('250000'), '250000');
  assert.throws(() => parseSeed('1e5'), /whole number/);
  assert.throws(() => parseSeed('-1'), /whole number/);
});

test('mergeV2 --replace keeps the old entry under previous', () => {
  const a = mergeV2(null, 'mock', { pool: '0x1', txs: [1] }, { replace: false });
  const b = mergeV2(a, 'mock', { pool: '0x2' }, { replace: true });
  assert.equal(b.pools.mock.pool, '0x2');
  assert.deepEqual(b.previous.mock, [{ pool: '0x1', txs: [1] }]);
  const c = mergeV2(b, 'mock', { pool: '0x3' }, { replace: true });
  assert.deepEqual(c.previous.mock.map((p) => p.pool), ['0x1', '0x2']);
  assert.equal(mergeV2(null, 'mock', { pool: '0x1' }, { replace: false }).previous, undefined);
});

const H = (n) => `0x${String(n).repeat(64)}`;
const mockRun = () => ({
  transactions: [
    { hash: H(1), transactionType: 'CREATE', contractName: 'MockPriceSource', contractAddress: '0xa1', transaction: { to: null } },
    { hash: H(2), transactionType: 'CREATE', contractName: 'MockPositionSource', contractAddress: '0xa2', transaction: { to: null } },
    { hash: H(3), transactionType: 'CREATE', contractName: 'CoverPool', contractAddress: '0xa3', transaction: { to: null } },
  ],
});
const fakeRpc = ({ chain = '0x3e6', status = '0x1', missing = null } = {}) => async (method, params) => {
  if (method === 'eth_chainId') return chain;
  if (method === 'eth_getTransactionReceipt') return params[0] === missing ? null : { status: params[0] === H(3) ? status : '0x1', gasUsed: '0x10' };
  throw new Error(`unexpected ${method}`);
};

test('verifyRun: accepts an all-status-1 mock run on 998', async () => {
  const sum = await verifyRun(mockRun(), 'mock', fakeRpc());
  assert.equal(sum.contracts.CoverPool, '0xa3');
  assert.ok(sum.txs.every((t) => t.status === 1 && t.gasUsed === 16));
});

test('verifyRun: refuses a run with a failed or missing receipt', async () => {
  await assert.rejects(verifyRun(mockRun(), 'mock', fakeRpc({ status: '0x0' })), /status-1/);
  await assert.rejects(verifyRun(mockRun(), 'mock', fakeRpc({ missing: H(1) })), /status-1/);
});

test('verifyRun: refuses chain id != 998 and a mode mismatch', async () => {
  await assert.rejects(verifyRun(mockRun(), 'mock', fakeRpc({ chain: '0x3e7' })), /chain 999/);
  await assert.rejects(verifyRun(mockRun(), 'mock', fakeRpc({ chain: '0x7a69' })), /chain 31337/);
  await assert.rejects(verifyRun(mockRun(), 'hypercore', fakeRpc()), /not a hypercore deploy/);
});

test('parseDeployArgs: --record-only and --run', () => {
  const a = parseDeployArgs(['--record-only', '--mode', 'mock', '--run', 'x.json']);
  assert.equal(a.recordOnly, true);
  assert.equal(a.run, 'x.json');
  assert.throws(() => parseDeployArgs(['--run', 'x.json']), /--record-only/);
  assert.throws(() => parseDeployArgs(['--record-only', '--fork']), /cannot be combined/);
});
