import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANVIL_ACCOUNT0,
  childEnv,
  decimalToPx6,
  forgeArgs,
  mergeV2,
  parseDeployArgs,
  parseLimits,
  perpList,
  standinFromInfo,
  summarizeBroadcast,
} from './deployv2.mjs';

test('parseDeployArgs: defaults, flags, validation', () => {
  assert.deepEqual(parseDeployArgs([]), {
    dryRun: false, yes: false, mode: 'hypercore', rpc: null, standinPx: null, gasPrice: null, replace: false, help: false,
  });
  const a = parseDeployArgs(['--dry-run', '--yes', '--mode', 'mock', '--standin-px', '1,2', '--gas-price', '100']);
  assert.equal(a.dryRun, true);
  assert.equal(a.mode, 'mock');
  assert.deepEqual(a.standinPx, ['1', '2']);
  assert.throws(() => parseDeployArgs(['--mode', 'real']), /hypercore or mock/);
  assert.throws(() => parseDeployArgs(['--rpc']), /needs a value/);
  assert.throws(() => parseDeployArgs(['--standin-px', '0,1']), /positive/);
  assert.throws(() => parseDeployArgs(['--broadcast']), /unknown/);
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

test('forgeArgs: skip-simulation and slow always; key never in argv', () => {
  const real = forgeArgs({ rpc: 'https://r', dryRun: false });
  assert.ok(real.includes('--skip-simulation') && real.includes('--slow') && real.includes('--broadcast'));
  assert.equal(real.some((x) => /key/i.test(x)), false);
  const dry = forgeArgs({ rpc: 'http://127.0.0.1:1', dryRun: true, gasPrice: '7' });
  assert.deepEqual(dry.slice(-5), ['--unlocked', '--sender', ANVIL_ACCOUNT0, '--with-gas-price', '7']);
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
