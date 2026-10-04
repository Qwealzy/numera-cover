// Unit tests for scripts/lib/e2e.mjs (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { repoRoot } from './tools.mjs';
import { venvPython } from '../venv.mjs';
import {
  DEFAULTS,
  EVENT_SIGS,
  SEL,
  SIGS,
  TOPIC,
  breachPrice,
  buyCoverCalldata,
  calldata,
  capacityCheck,
  checkQuote,
  chooseFees,
  coverIdFromReceipt,
  decodeCover,
  decodeLimits,
  decodeTriggerReceipt,
  e2eKey,
  findTriggerTx,
  fmtUsdc,
  jsonable,
  levelFor,
  levelMarginBps,
  localDate,
  mergeE2e,
  parseE2eArgs,
  planPosition,
  positionCovers,
  scrub,
  signerSpawn,
  toInt64,
  word,
  words,
} from './e2e.mjs';

const POOL = '0x493c14a92da0905b06a91a1e87a75d4bff75e4a6';
const USDC = '0x8675c05F2403f220e19057F3f60c6c91bb14462A';
const BUYER = '0x2BA514Ca28fc6f34072F2cBB7467D0849cfF52A9';
const KEEPER = '0x9a809EF608F5AE30Ddd26708cC6794bD7dad7a1B';
const LIM = {
  maxUtilizationBps: 8000n, perPerpCapBps: 5000n, maxDuration: 604800n, maxSpotDeviationBps: 30n, minPayout: 1_000_000n,
  minPremiumBps: 20n, minLevelDistanceBps: 25n, saleWindow: 3600n, maxSoldPerWindowBps: 2500n, maxBuyerWindowShareBps: 2500n,
  maxPaidPerWindowBps: 1500n,
};
const cast = path.join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'cast.exe' : 'cast');

test('parseE2eArgs: defaults, flags, validation', () => {
  const d = parseE2eArgs([]);
  assert.equal(d.yes, false);
  assert.equal(d.fork, false);
  assert.equal(d.selfTrigger, false);
  assert.equal(d.payout, 10_000_000n);
  assert.equal(d.levelBps, 100);
  assert.equal(d.waitS, 60);
  assert.equal(d.reset, true);
  assert.equal(d.engine, 'http://localhost:8000');
  const a = parseE2eArgs(['--yes', '--payout', '5000000', '--level-bps', '150', '--wait', '30', '--engine', 'http://127.0.0.1:9000/', '--no-reset']);
  assert.deepEqual([a.yes, a.payout, a.levelBps, a.waitS, a.engine, a.reset], [true, 5_000_000n, 150, 30, 'http://127.0.0.1:9000', false]);
  assert.equal(parseE2eArgs(['--fork']).selfTrigger, true); // the live keeper cannot see a fork
  assert.equal(parseE2eArgs(['--self-trigger']).selfTrigger, true);
  assert.throws(() => parseE2eArgs(['--payout', '0']), /positive integer/);
  assert.throws(() => parseE2eArgs(['--payout', '1.5']), /positive integer/);
  assert.throws(() => parseE2eArgs(['--level-bps', '0']), /\[1, 2000\]/);
  assert.throws(() => parseE2eArgs(['--duration', '60']), /\[600/);
  assert.throws(() => parseE2eArgs(['--rpc']), /needs a value/);
  assert.throws(() => parseE2eArgs(['--private-key', 'x']), /unknown argument/); // no way to pass a key on argv
  assert.throws(() => parseE2eArgs(['--engine', 'localhost:8000']), /http/);
  assert.throws(() => parseE2eArgs(['--max-fee-gwei', '0']), /> 0/);
});

test('level, breach and margin arithmetic (px6)', () => {
  assert.equal(levelFor(86_910_000_000n, true, 100), 86_040_900_000n);
  assert.equal(breachPrice(86_040_900_000n, true, 50), 85_610_695_500n);
  assert.equal(levelFor(100_000_000n, false, 100), 101_000_000n);
  assert.equal(breachPrice(101_000_000n, false, 50), 101_505_000n);
  assert.equal(levelMarginBps(LIM), 56); // §6: 56 bps on testnet
  // the breach is past the level, and the level is past the margin from the reference
  const ref = 86_910_000_000n;
  const lvl = levelFor(ref, true, DEFAULTS.levelBps);
  assert.ok(breachPrice(lvl, true, DEFAULTS.breachBps) <= lvl);
  assert.ok((ref - lvl) * 10_000n >= ref * BigInt(levelMarginBps(LIM)));
});

test('planPosition: margin cap covers the payout with headroom; existing positions', () => {
  const p = planPosition({ payout: 10_000_000n, px6: 86_910_000_000n, isLong: true, leverage: 10, szDecimals: 5 });
  assert.equal(p.entryNtl, 200_000_000n);
  assert.equal(p.leverage, 10);
  assert.equal(p.szi, 230n); // 200 USD / 86,910 USD = 0.00230 BTC = 230 units at szDecimals 5
  assert.equal(p.entryNtl / BigInt(p.leverage), 20_000_000n);
  assert.ok(planPosition({ payout: 10_000_000n, px6: 1_000_000n, isLong: false, leverage: 5, szDecimals: 0 }).szi < 0n);
  assert.equal(positionCovers({ szi: 0n, entryNtl: 0n, leverage: 0 }, true, 1n), false);
  assert.equal(positionCovers({ szi: 230n, entryNtl: 200_000_000n, leverage: 10 }, true, 10_000_000n), true);
  assert.equal(positionCovers({ szi: 230n, entryNtl: 200_000_000n, leverage: 10 }, true, 30_000_000n), false);
  assert.equal(positionCovers({ szi: -230n, entryNtl: 200_000_000n, leverage: 10 }, true, 1n), false);
});

const state = (o = {}) => ({
  limits: LIM, capacityBase: 2_000_000_000n, lockedAssets: 0n, lockedByPerp: 0n, windowStart: 0n, windowAssets: 0n,
  soldInWindow: 0n, buyerWindowStart: 0n, buyerWindowSold: 0n, paidWindowStart: 0n, paidWindowAssets: 0n, paidInWindow: 0n, ...o,
});

test('capacityCheck mirrors the contract caps and the payout breaker', () => {
  const now = 1_790_000_000n;
  const ok = capacityCheck(state(), 10_000_000n, now, 3);
  assert.equal(ok.ok, true);
  assert.equal(ok.room.cap, 500_000_000n);
  assert.equal(ok.room.buyerCap, 125_000_000n); // 2,000 x 25 % x 25 %
  assert.equal(ok.room.paidCap, 300_000_000n);
  assert.match(capacityCheck(state(), 126_000_000n, now, 3).problems.join(), /buyer window share/);
  // open window: the snapshot is the base, and the buyer's earlier sales count
  const open = state({ windowStart: now - 10n, windowAssets: 2_000_000_000n, soldInWindow: 495_000_000n, buyerWindowStart: now - 10n, buyerWindowSold: 120_000_000n });
  const r = capacityCheck(open, 10_000_000n, now, 3);
  assert.match(r.problems.join(), /sale window/);
  assert.match(r.problems.join(), /buyer window share/);
  // a window that ended resets the throttle
  assert.equal(capacityCheck({ ...open, windowStart: now - 3600n }, 10_000_000n, now, 3).ok, true);
  // a trigger that would trip the breaker (and pause the pool) is refused up front
  const br = state({ paidWindowStart: now - 5n, paidWindowAssets: 2_000_000_000n, paidInWindow: 295_000_000n });
  assert.match(capacityCheck(br, 10_000_000n, now, 3).problems.join(), /payout breaker/);
  assert.match(capacityCheck(state(), 999_999n, now, 3).problems.join(), /minPayout/);
  assert.match(capacityCheck(state({ lockedAssets: 1_595_000_000n }), 10_000_000n, now, 3).problems.join(), /utilization/);
});

test('selectors and event topics match cast', { skip: !existsSync(cast) && 'cast not installed' }, () => {
  for (const [k, sig] of Object.entries(SIGS)) {
    const r = spawnSync(cast, ['sig', sig], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.stdout.trim(), `0x${SEL[k]}`, sig);
  }
  for (const [k, sig] of Object.entries(EVENT_SIGS)) {
    const r = spawnSync(cast, ['sig-event', sig], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.stdout.trim(), TOPIC[k], sig);
  }
});

test('ABI encoding: words, calldata and buyCover against cast calldata', () => {
  assert.equal(word(true), `${'0'.repeat(63)}1`);
  assert.equal(word(-1n), 'f'.repeat(64));
  assert.equal(toInt64(BigInt(`0x${word(-230n)}`)), -230n);
  assert.equal(calldata('setPrice', [3, 86_910_000_000n]), `0x98764f22${word(3)}${word(86_910_000_000n)}`);
  assert.throws(() => calldata('nope'), /no selector/);
  const q = { buyer: BUYER, perpIndex: 3, isLong: true, level: 86_040_900_000, payout: 10_000_000, premium: 123_456, expiry: 1_790_000_000, spotRef: 86_910_000_000, deadline: 1_789_996_430, nonce: 4_503_599_627_370_495 };
  const sig = `0x${'ab'.repeat(32)}${'cd'.repeat(32)}1b`;
  const mine = buyCoverCalldata(q, sig);
  if (existsSync(cast)) {
    const tuple = `(${BUYER},3,true,86040900000,10000000,123456,1790000000,86910000000,1789996430,4503599627370495)`;
    const r = spawnSync(cast, ['calldata', 'buyCover((address,uint32,bool,uint64,uint256,uint256,uint64,uint64,uint64,uint256),bytes)', tuple, sig], { encoding: 'utf8', windowsHide: true });
    assert.equal(mine, r.stdout.trim());
    const r2 = spawnSync(cast, ['calldata', 'setPosition(address,uint32,int64,uint64,uint32)', '--', BUYER, '3', '-230', '200000000', '10'], { encoding: 'utf8', windowsHide: true });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(calldata('setPosition', [BUYER, 3, -230n, 200_000_000n, 10]), r2.stdout.trim());
  }
  assert.throws(() => buyCoverCalldata(q, '0xabc'), /not hex/);
});

test('decoders: getCover, limits, receipts, trigger tx', () => {
  const coverHex = `0x${[BUYER, 3, true, 86_040_900_000n, 10_000_000n, 123_456n, 1n, 2n, 2].map(word).join('')}`;
  const c = decodeCover(coverHex);
  assert.equal(c.status, 'Paid');
  assert.equal(c.buyer.toLowerCase(), BUYER.toLowerCase());
  assert.equal(c.payout, 10_000_000n);
  assert.equal(decodeLimits(`0x${Object.values(LIM).map(word).join('')}`).maxBuyerWindowShareBps, 2500n);
  assert.throws(() => words('0x1234'), /whole words/);

  const t = (a) => `0x${word(a)}`;
  const buy = { logs: [{ address: POOL, topics: [TOPIC.CoverPurchased, t(7n), t(BUYER), t(3)], data: '0x' }] };
  assert.equal(coverIdFromReceipt(buy, POOL), 7n);
  assert.equal(coverIdFromReceipt(buy, USDC), null);
  const trig = {
    logs: [
      { address: POOL, topics: [TOPIC.CoverTriggered, t(7n)], data: `0x${word(85_610_695_500n)}${word(KEEPER)}` },
      { address: USDC.toLowerCase(), topics: [TOPIC.Transfer, t(POOL), t(BUYER)], data: `0x${word(10_000_000n)}` },
      { address: USDC, topics: [TOPIC.Transfer, t(BUYER), t(POOL)], data: `0x${word(5n)}` },
    ],
  };
  const d = decodeTriggerReceipt(trig, { pool: POOL, usdc: USDC, buyer: BUYER });
  assert.equal(d.coverId, 7n);
  assert.equal(d.caller.toLowerCase(), KEEPER.toLowerCase());
  assert.equal(d.oraclePx, 85_610_695_500n);
  assert.equal(d.payoutTransfer, 10_000_000n);
  assert.equal(d.deferred || d.breaker, false);

  const block = { transactions: [
    { hash: '0x01', to: POOL, input: calldata('trigger', [6n]) },
    { hash: '0x02', to: USDC, input: calldata('trigger', [7n]) },
    { hash: '0x03', to: POOL.toUpperCase().replace('0X', '0x'), input: calldata('trigger', [7n]) },
  ] };
  assert.equal(findTriggerTx(block, POOL, 7n).hash, '0x03');
  assert.equal(findTriggerTx(block, POOL, 8n), null);
  assert.equal(findTriggerTx({ transactions: ['0xabc'] }, POOL, 7n), null);
});

test('checkQuote: accepts the asked-for quote, flags drift', () => {
  const want = { buyer: BUYER, perpIndex: 3, isLong: true, level: 86_040_900_000n, payout: 10_000_000n, spotRef: 86_910_000_000n, pool: POOL };
  const q = { buyer: BUYER.toLowerCase(), perpIndex: 3, isLong: true, level: 86_040_900_000, payout: 10_000_000, premium: 120_000, expiry: 1, spotRef: 86_910_000_000, deadline: 1, nonce: 5 };
  const resp = { quote: q, signature: '0xab', breakdown: { pool: POOL } };
  assert.deepEqual(checkQuote(resp, want), []);
  assert.match(checkQuote({ ...resp, quote: { ...q, spotRef: 86_384_000_000 } }, want).join(), /^spotRef/);
  assert.match(checkQuote({ ...resp, quote: { ...q, premium: 6_000_000 } }, want).join(), /half the payout/);
  assert.match(checkQuote({ ...resp, breakdown: { pool: USDC } }, want).join(), /signed for pool/);
  assert.match(checkQuote({ ...resp, quote: { ...q, nonce: 2 ** 60 } }, want).join(), /nonce/);
  assert.match(checkQuote({ error: 'capacity' }, want).join(), /no quote/);
});

test('record: key naming, merge under pools.mock, BigInt JSON', () => {
  assert.match(localDate(new Date(2026, 9, 2, 23, 59)), /^2026-10-02$/);
  assert.equal(e2eKey('2026-10-02', false, {}), 'e2e_F9_2026-10-02');
  assert.equal(e2eKey('2026-10-02', false, { 'e2e_F9_2026-10-02': {} }), 'e2e_F9_2026-10-02_2');
  assert.equal(e2eKey('2026-10-02', true, {}), 'e2e_F9_selftrigger_2026-10-02');
  // A fixture shaped like deployments/testnet-v2.json (never the live file: a pool redeploy changes it).
  const doc = {
    env: 'testnet',
    chainId: 998,
    pools: {
      mock: { mode: 'mock', pool: POOL, usdc: USDC, 'e2e_F9_old': { b: 2 } },
      hypercore: { mode: 'hypercore', pool: '0x1111111111111111111111111111111111111111', usdc: USDC },
    },
    previous: { mock: [{ mode: 'mock', pool: '0x2222222222222222222222222222222222222222' }] },
  };
  const out = mergeE2e(doc, POOL.toUpperCase().replace('0X', '0x'), 'e2e_F9_x', { a: 1 });
  assert.deepEqual(out.pools.mock.e2e_F9_x, { a: 1 });
  assert.equal(doc.pools.mock.e2e_F9_x, undefined); // input untouched
  assert.deepEqual(Object.keys(out.pools.hypercore), Object.keys(doc.pools.hypercore));
  assert.throws(() => mergeE2e(doc, USDC, 'k', {}), /this run used/);
  assert.throws(() => mergeE2e(out, POOL, 'e2e_F9_x', {}), /already has/);
  assert.deepEqual(jsonable({ a: 5n, b: [2n ** 70n], c: 'x' }), { a: 5, b: ['1180591620717411303424'], c: 'x' });
  assert.equal(fmtUsdc(10_000_000n), '10.000000');
  assert.equal(fmtUsdc(-1n), '-0.000001');
});

test('chooseFees: 2 x base + tip under the ceiling', () => {
  assert.deepEqual(chooseFees(100n, 0n, 10n ** 10n), { maxFeePerGas: 200n, maxPriorityFeePerGas: 0n });
  assert.deepEqual(chooseFees(6n * 10n ** 9n, 1n, 10n ** 10n), { maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 1n });
  assert.throws(() => chooseFees(11n * 10n ** 9n, 0n, 10n ** 10n), /ceiling/);
});

// -- the key never reaches argv or output ---------------------------------------------------------------

test('signerSpawn: the key is in the child env only, never in argv; other secrets are dropped', () => {
  const key = `0x${randomBytes(32).toString('hex')}`; // throwaway, never printed
  const spec = signerSpawn({ baseEnv: { PATH: 'x', KEEPER_KEY: 'k', QUOTE_SIGNER_KEY: 'q', DEPLOYER_KEY: 'shell' }, dotenv: { DEPLOYER_KEY: key }, allow: [POOL, USDC] });
  assert.ok(!spec.args.some((a) => a.includes(key.slice(2))));
  assert.equal(spec.env.DEPLOYER_KEY, key);
  assert.equal(spec.env.KEEPER_KEY, undefined);
  assert.equal(spec.env.QUOTE_SIGNER_KEY, undefined);
  assert.equal(spec.env.E2E_SIGNER_ALLOW, `${POOL},${USDC.toLowerCase()}`);
  assert.throws(() => signerSpawn({ baseEnv: {}, dotenv: {}, allow: [] }), /DEPLOYER_KEY is not set/);
  assert.equal(scrub(`oops ${key} and ${key.slice(2).toUpperCase()}`, [key]).includes(key.slice(2)), false);
});

test('the script never puts the key on a command line or in a print', () => {
  const src = readFileSync(path.join(repoRoot, 'scripts', 'e2e-mock-v2.mjs'), 'utf8');
  // the only reads of DEPLOYER_KEY: the presence check, the scrub list, and signerSpawn (env only)
  const uses = src.split('\n').filter((l) => l.includes('DEPLOYER_KEY') && !/^\s*\/\//.test(l));
  for (const l of uses) assert.ok(!/(spawn|args|argv|push)\(/.test(l) || /startSigner|readDotenv/.test(l), l);
  assert.ok(!/--private-key/.test(src));
  assert.ok(!/console\.log\([^)]*dotenv/.test(src));
});

const py = venvPython(repoRoot);
test('signer child: signs for 998 and the allowlist only; the key never appears in its output', { skip: !py && 'engine venv not found' }, async () => {
  const key = `0x${randomBytes(32).toString('hex')}`; // throwaway, never printed
  const spec = signerSpawn({ baseEnv: process.env, dotenv: { DEPLOYER_KEY: key }, allow: [POOL] });
  const child = spawn(py, spec.args, { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let all = '';
  child.stderr.on('data', (d) => (all += d));
  const lines = createInterface({ input: child.stdout });
  const it = lines[Symbol.asyncIterator]();
  const next = async () => {
    const { value } = await it.next();
    all += `${value}\n`;
    return JSON.parse(value);
  };
  const hello = await next();
  assert.match(hello.address, /^0x[0-9a-fA-F]{40}$/);
  const tx = { chainId: 998, nonce: '0', to: POOL, data: calldata('trigger', [1n]), gas: '100000', maxFeePerGas: '200', maxPriorityFeePerGas: '0' };
  child.stdin.write(`${JSON.stringify({ tx })}\n`);
  const ok = await next();
  assert.match(ok.raw, /^0x02[0-9a-f]+$/);
  assert.match(ok.hash, /^0x[0-9a-f]{64}$/);
  child.stdin.write(`${JSON.stringify({ tx: { ...tx, chainId: 999 } })}\n`);
  assert.match((await next()).error, /refusing chainId 999/);
  child.stdin.write(`${JSON.stringify({ tx: { ...tx, to: USDC } })}\n`);
  assert.match((await next()).error, /not allowlisted/);
  child.stdin.end();
  await new Promise((r) => child.once('exit', r));
  assert.equal(all.toLowerCase().includes(key.slice(2).toLowerCase()), false);
});
