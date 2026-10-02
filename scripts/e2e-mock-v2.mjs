#!/usr/bin/env node
// F9 re-proof on the live CoverPool v2 MOCK pool: "keeper triggers a breached cover on testnet" (features.json F9).
// The founder runs it; works from PowerShell, cmd and Git Bash.
//
//   node scripts/e2e-mock-v2.mjs                    # testnet (998): preflight + plan, sends nothing
//   node scripts/e2e-mock-v2.mjs --yes              # testnet (998): runs the flow as the deployer
//   node scripts/e2e-mock-v2.mjs --fork --yes       # local anvil fork of testnet: same flow, impersonated deployer
//   node scripts/e2e-mock-v2.mjs --help
//
// Flow (as the deployer, who owns the mock sources): mock long position on the perp (margin cap 2 x payout),
// mock price = live testnet oracle, POST /quote to the engine (level 1 % below), approve exactly the premium,
// buyCover; then the mock price goes past the level and the script waits for the KEEPER's trigger (getCover
// every 1 s, up to --wait s). It never triggers on its own unless --self-trigger is given, and then records the
// run as NOT an F9 proof. Afterwards it finds the trigger tx (block scan, no eth_getLogs), checks the caller is
// the keeper and the mUSDC Transfer pool -> deployer equals the payout, resets the mock price to the live
// oracle and merges an e2e_F9_<date> block into deployments/testnet-v2.json under pools.mock.
//
// Safety: every RPC used must answer eth_chainId 998 (checked again before each send); a known mainnet RPC host is
// refused without a network call. DEPLOYER_KEY is read from .env inside this process and handed to a signer
// child (engine venv python, eth_account) through its environment only: never on a command line, never printed.
// The signer itself refuses any chain but 998/31337 and any address outside this run's four contracts.
// --fork reads no key at all: anvil impersonates the deployer, and the run's record goes to a temp file.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { repoRoot, git } from './lib/tools.mjs';
import { readDotenv } from './lib/env.mjs';
import { host, looksLikeMainnetRpc } from './lib/rpc.mjs';
import { decimalToPx6 } from './lib/deployv2.mjs';
import { venvPython } from './venv.mjs';
import {
  DEFAULTS,
  TESTNET_CHAIN_ID,
  USAGE,
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
  fmtPx,
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
  toAddr,
  toInt64,
  words,
} from './lib/e2e.mjs';

const INFO_API = 'https://api.hyperliquid-testnet.xyz/info';
const GWEI = 1_000_000_000;
let secrets = []; // values scrubbed from every printed line (the key never reaches a print, this is a backstop)
const say = (m) => console.log(scrub(`[e2e] ${m}`, secrets));
class Stop extends Error {}
const die = (m) => {
  throw new Stop(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bin = (name) => {
  const p = path.join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? `${name}.exe` : name);
  return existsSync(p) ? p : name;
};
const lc = (a) => String(a ?? '').toLowerCase();
const children = [];

// -- JSON-RPC ----------------------------------------------------------------------------------------

async function rpcCall(url, method, params = [], { retries = 4 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => null);
      const limited = res.status === 429 || body?.error?.code === -32005 || /rate limit/i.test(body?.error?.message ?? '');
      if (!limited && body && !body.error) return body.result;
      if (!limited && body?.error) throw new Stop(`${method}: ${body.error.message}${body.error.data ? ` (${String(body.error.data).slice(0, 140)})` : ''}`);
      last = new Error(`${method}: ${limited ? 'rate-limited' : `HTTP ${res.status}`} on ${host(url)}`);
    } catch (e) {
      if (e instanceof Stop) throw e;
      last = new Error(`${method}: ${e.name === 'TimeoutError' ? 'timeout' : e.message} on ${host(url)}`);
    }
    await sleep(500 * 2 ** i);
  }
  throw last;
}

async function requireChain(url, want = TESTNET_CHAIN_ID) {
  if (looksLikeMainnetRpc(url)) die(`refusing ${host(url)}: a mainnet RPC host`);
  let id;
  try {
    id = Number(BigInt(await rpcCall(url, 'eth_chainId')));
  } catch (e) {
    die(`eth_chainId failed on ${host(url)}: ${e.message}`);
  }
  if (id !== want) die(`${host(url)} answers chain ${id}; this run needs ${want}. Nothing was sent.`);
}

const ethCall = (rpc, to, data) => rpcCall(rpc, 'eth_call', [{ to, data }, 'latest']);
const read1 = async (rpc, to, name, args = []) => words(await ethCall(rpc, to, calldata(name, args)))[0];

// -- local processes ---------------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Anvil fork of testnet: chain id 998, auto-impersonation (the deployer sends without a key).
async function startAnvil(forkUrl) {
  const port = await freePort();
  const a = spawn(bin('anvil'), ['--port', String(port), '--silent', '--fork-url', forkUrl, '--chain-id', String(TESTNET_CHAIN_ID), '--auto-impersonate'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  children.push(a);
  let exited = null;
  a.once('exit', (code) => (exited = code));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && exited === null) {
    try {
      await rpcCall(url, 'eth_chainId', [], { retries: 0 });
      return url;
    } catch {
      await sleep(250);
    }
  }
  die(exited !== null ? `anvil exited with code ${exited} (fork of ${host(forkUrl)} failed?)` : 'anvil did not start');
}

function killAll() {
  for (const c of children.splice(0)) {
    if (!c.pid || c.exitCode !== null) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else c.kill('SIGTERM');
  }
}

// Running keepers on this machine: [{pid, dryRun}]. Only the pid and the flag are printed, never a command line.
function findKeepers() {
  if (process.platform === 'win32') {
    const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'numera_engine\\.keeper' -and $_.Name -match '^python' } | ForEach-Object { '{0} {1}' -f $_.ProcessId, [int]($_.CommandLine -match '--dry-run') }";
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    if (r.status !== 0) return null;
    return r.stdout.split(/\r?\n/).filter((l) => /^\d+ [01]$/.test(l.trim())).map((l) => ({ pid: Number(l.split(' ')[0]), dryRun: l.trim().endsWith('1') }));
  }
  const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout
    .split('\n')
    .filter((l) => /python/.test(l) && /numera_engine\.keeper/.test(l))
    .map((l) => ({ pid: Number(l.trim().split(/\s+/)[0]), dryRun: /--dry-run/.test(l) }));
}

// Signer child (testnet only): engine venv python + eth_account, DEPLOYER_KEY in its env only.
async function startSigner(dotenv, allow) {
  const py = venvPython(repoRoot);
  if (!py) die('engine venv not found (engine/.venv); the signer needs eth_account');
  const spec = signerSpawn({ baseEnv: process.env, dotenv, allow });
  const child = spawn(py, spec.args, { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const lines = createInterface({ input: child.stdout });
  const queue = [];
  const waiters = [];
  lines.on('line', (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)));
  const next = () =>
    new Promise((resolve, reject) => {
      if (queue.length) return resolve(queue.shift());
      const t = setTimeout(() => reject(new Stop(`signer did not answer${stderr ? `: ${scrub(stderr.trim().split('\n').pop(), secrets)}` : ''}`)), 30_000);
      waiters.push((l) => {
        clearTimeout(t);
        resolve(l);
      });
    });
  const hello = JSON.parse(await next());
  if (hello.error) die(`signer: ${hello.error}`);
  return {
    address: hello.address,
    async sign(tx) {
      child.stdin.write(`${JSON.stringify({ tx })}\n`);
      const r = JSON.parse(await next());
      if (r.error) die(`signer refused: ${r.error}`);
      return r;
    },
  };
}

// -- main --------------------------------------------------------------------------------------------

async function main() {
  const args = parseE2eArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  const date = localDate();
  const deployments = JSON.parse(readFileSync(path.join(repoRoot, 'deployments', 'testnet.json'), 'utf8'));
  const v2File = path.join(repoRoot, 'deployments', 'testnet-v2.json');
  const v2doc = JSON.parse(readFileSync(v2File, 'utf8'));
  const mock = v2doc.pools?.mock;
  if (!mock?.pool) die('deployments/testnet-v2.json has no pools.mock');
  const pool = mock.pool;
  const perpIndex = deployments.perps?.[args.coin];
  if (!Number.isInteger(perpIndex)) die(`${args.coin} is not in deployments/testnet.json perps`);
  if (mock.config?.perps?.[args.coin] && mock.config.perps[args.coin].index !== perpIndex) die(`perp index for ${args.coin} differs between the deployments files`);
  const deployer = deployments.deployer;
  const keeper = deployments.keeper;
  if (!/^0x[0-9a-fA-F]{40}$/.test(deployer ?? '') || !/^0x[0-9a-fA-F]{40}$/.test(keeper ?? '')) die('deployments/testnet.json needs deployer and keeper addresses');
  const isLong = true;

  // RPCs: the testnet RPC (fork source with --fork), then the fork itself.
  const srcRpc = args.rpc ?? DEFAULTS.rpc;
  await requireChain(srcRpc);
  say(`rpc          ${host(srcRpc)} answers chain 998`);
  let rpc = srcRpc;
  if (args.fork) {
    say(`starting an anvil fork of ${host(srcRpc)} (chain 998, deployer impersonated)`);
    rpc = await startAnvil(srcRpc);
    await requireChain(rpc);
    say(`fork         ${host(rpc)} answers chain 998`);
  }

  // Engine.
  let health;
  try {
    health = await (await fetch(`${args.engine}/health`, { signal: AbortSignal.timeout(10_000) })).json();
  } catch (e) {
    die(`engine ${args.engine}/health failed: ${e.message}. Start it with: node scripts/dev.mjs`);
  }
  if (!health?.ok) die(`engine /health is not ok: ${JSON.stringify(health)}`);
  if (Number(health.chainId) !== TESTNET_CHAIN_ID) die(`engine signs for chain ${health.chainId}, not 998`);
  if (!(health.pools ?? []).map(lc).includes(lc(pool))) die(`engine allowlist does not include the MOCK v2 pool ${pool}`);
  say(`engine       ${args.engine} ok, chain 998, signer ${health.signer}, MOCK v2 pool allowlisted`);

  // Live oracle and szDecimals from the testnet Info API (read-only).
  const meta = await (
    await fetch(INFO_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }), signal: AbortSignal.timeout(15_000) })
  ).json();
  const liveOracle = async () => {
    const m = await (
      await fetch(INFO_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }), signal: AbortSignal.timeout(15_000) })
    ).json();
    return BigInt(decimalToPx6(m[1][perpIndex].oraclePx));
  };
  const u = meta?.[0]?.universe?.[perpIndex];
  if (!u || u.name !== args.coin) die(`Info API perp ${perpIndex} is ${u?.name ?? 'missing'}, deployments says ${args.coin}`);
  const szDecimals = u.szDecimals;
  const oraclePx = BigInt(decimalToPx6(meta[1][perpIndex].oraclePx));

  // Pool and sources (on the RPC the run sends to).
  const addrOf = async (to, name) => toAddr(await read1(rpc, to, name));
  const priceSource = await addrOf(pool, 'priceSource');
  const positionSource = await addrOf(pool, 'positionSource');
  const usdc = await addrOf(pool, 'asset');
  if (lc(priceSource) !== lc(mock.priceSource) || lc(positionSource) !== lc(mock.positionSource) || lc(usdc) !== lc(mock.usdc)) die('pool sources differ from deployments/testnet-v2.json');
  try {
    await read1(rpc, pool, 'minPremiumBps');
  } catch {
    die(`${pool} does not answer minPremiumBps(): not a v2 pool`);
  }
  for (const src of [priceSource, positionSource]) {
    const o = await addrOf(src, 'owner');
    if (lc(o) !== lc(deployer)) die(`mock source ${src} is owned by ${o}, not the deployer`);
  }
  const paused = (await read1(rpc, pool, 'paused')) === 1n;
  if (paused) die('the MOCK v2 pool is paused');
  if ((await read1(rpc, pool, 'perpAllowed', [perpIndex])) !== 1n) die(`perp ${perpIndex} is not allowed on the pool`);
  const limits = decodeLimits(await ethCall(rpc, pool, calldata('limits')));
  const head = await rpcCall(rpc, 'eth_getBlockByNumber', ['latest', false]);
  const now = BigInt(head.timestamp);
  const bw = words(await ethCall(rpc, pool, calldata('buyerWindow', [deployer])));
  const st = {
    limits,
    capacityBase: await read1(rpc, pool, 'capacityBase'),
    lockedAssets: await read1(rpc, pool, 'lockedAssets'),
    lockedByPerp: await read1(rpc, pool, 'lockedByPerp', [perpIndex]),
    windowStart: await read1(rpc, pool, 'windowStart'),
    windowAssets: await read1(rpc, pool, 'windowAssets'),
    soldInWindow: await read1(rpc, pool, 'soldInWindow'),
    buyerWindowStart: bw[0],
    buyerWindowSold: bw[1],
    paidWindowStart: await read1(rpc, pool, 'paidWindowStart'),
    paidWindowAssets: await read1(rpc, pool, 'paidWindowAssets'),
    paidInWindow: await read1(rpc, pool, 'paidInWindow'),
  };
  const cap = capacityCheck(st, args.payout, now, perpIndex);
  if (!cap.ok) die(`capacity: ${cap.problems.join('; ')}`);
  const margin = levelMarginBps(limits);
  if (args.levelBps <= margin) die(`--level-bps ${args.levelBps} is within the engine's ${margin} bps v2 margin`);

  // Reference price: the live oracle on testnet. On a fork the engine still reads the REAL chain's mock price
  // (it quotes against testnet), so the fork's mock price is set to that value instead.
  const realMockPx = await read1(srcRpc, priceSource, 'px6Of', [perpIndex]);
  const refPx = args.fork ? realMockPx : oraclePx;
  if (refPx === 0n) die('no reference price (the real mock price is unset)');
  const level = levelFor(refPx, isLong, args.levelBps);
  const breachPx = breachPrice(level, isLong, DEFAULTS.breachBps);
  const curMockPx = await read1(rpc, priceSource, 'px6Of', [perpIndex]);
  const posW = words(await ethCall(rpc, positionSource, calldata('position', [deployer, perpIndex])));
  const pos = { szi: toInt64(posW[0]), entryNtl: posW[1], leverage: Number(posW[2]) };
  const plannedPos = planPosition({ payout: args.payout, px6: refPx, isLong, leverage: DEFAULTS.leverage, szDecimals });
  const needPos = !positionCovers(pos, isLong, args.payout);
  const bal = await read1(rpc, usdc, 'balanceOf', [deployer]);
  const needMint = bal < args.payout; // premium <= payout / 2 (checkQuote), so a balance of one payout is enough
  const mintAmt = args.payout > 20_000_000n ? args.payout : 20_000_000n;
  const hype = BigInt(await rpcCall(rpc, 'eth_getBalance', [deployer, 'latest']));
  const keeperHype = BigInt(await rpcCall(srcRpc, 'eth_getBalance', [keeper, 'latest']));
  const coverCount = await read1(rpc, pool, 'coverCount');

  let keepers = null;
  if (!args.fork) {
    keepers = findKeepers();
    if (keepers === null) say('WARN         could not list processes: make sure `node scripts/dev.mjs --keeper-only` is running');
    else if (!keepers.length) say('WARN         no running keeper process found (python -m numera_engine.keeper). Start: node scripts/dev.mjs --keeper-only');
    else if (keepers.every((k) => k.dryRun)) say(`WARN         only dry-run keeper(s) running (pid ${keepers.map((k) => k.pid).join(', ')}): a dry run never triggers`);
    else say(`keeper       process running (pid ${keepers.filter((k) => !k.dryRun).map((k) => k.pid).join(', ')})`);
    if (keeperHype < 10n ** 16n) say(`WARN         keeper ${keeper} has ${Number(keeperHype) / 1e18} HYPE: it may not afford the trigger`);
  }

  say('PLAN');
  say(`  chain        998 (${args.fork ? 'local anvil fork of testnet' : 'testnet'}) via ${host(rpc)}`);
  say(`  pool         ${pool} (MOCK v2), B ${fmtUsdc(st.capacityBase)} mUSDC, locked ${fmtUsdc(st.lockedAssets)}, covers so far ${coverCount}`);
  say(`  caps         window ${fmtUsdc(cap.room.cap)}, buyer ${fmtUsdc(cap.room.buyerCap)}, breaker ${fmtUsdc(cap.room.paidCap)}, level margin ${margin} bps`);
  say(`  buyer        ${deployer} (deployer${args.fork ? ', impersonated on the fork' : ', DEPLOYER_KEY from .env via the signer child'}), ${fmtUsdc(bal)} mUSDC, ${(Number(hype) / 1e18).toFixed(4)} HYPE`);
  say(`  keeper       ${keeper} (${(Number(keeperHype) / 1e18).toFixed(4)} HYPE on testnet)${args.fork ? '; on the fork a read-only keeper is started' : ''}`);
  say(`  perp         ${args.coin}=${perpIndex} (szDecimals ${szDecimals}), live oracle ${fmtPx(oraclePx)}, mock now ${fmtPx(curMockPx)}${args.fork ? `, real mock ${fmtPx(realMockPx)}` : ''}`);
  if (needMint) say(`  1. mint       ${fmtUsdc(mintAmt)} mUSDC to the deployer (public mint)`);
  else say('  1. mint       not needed');
  if (needPos) say(`  2. position   setPosition(deployer, ${perpIndex}, szi ${plannedPos.szi}, entryNtl ${fmtUsdc(plannedPos.entryNtl)}, lev ${plannedPos.leverage}) -> margin cap ${fmtUsdc(plannedPos.entryNtl / BigInt(plannedPos.leverage))}`);
  else say(`  2. position   existing long covers the payout (szi ${pos.szi}, entryNtl ${fmtUsdc(pos.entryNtl)}, lev ${pos.leverage})`);
  say(`  3. price      setPrice(${perpIndex}, ${fmtPx(refPx)}) ${args.fork ? '(the real mock price the engine reads)' : '(live oracle)'}`);
  say(`  4. quote      long, level ${fmtPx(level)} (${args.levelBps} bps below), payout ${fmtUsdc(args.payout)}, ${args.durationSec} s`);
  say('  5. buy        approve(pool, premium) then buyCover(quote, signature)');
  say(`  6. breach     setPrice(${perpIndex}, ${fmtPx(breachPx)}) (${DEFAULTS.breachBps} bps below the level)`);
  say(`  7. wait       for the keeper's trigger, getCover every 1 s, up to ${args.waitS} s${args.selfTrigger ? '; then a deployer trigger (NOT an F9 proof)' : '; never triggers itself'}`);
  say(`  8. reset      ${args.reset ? `setPrice back to ${args.fork ? 'the reference price' : 'the live oracle'}` : 'skipped (--no-reset)'}`);
  say(`  writes       ${args.fork ? 'a temp file' : `${path.relative(repoRoot, v2File)} pools.mock.${e2eKey(date, false, mock)} (or e2e_F9_selftrigger_...)`}`);
  if (!args.yes) {
    say('nothing sent: re-run with --yes to execute');
    return;
  }

  // -- execute -------------------------------------------------------------------------------------
  const allow = [pool, priceSource, positionSource, usdc];
  let signer = null;
  if (!args.fork) {
    const dotenv = readDotenv(path.join(repoRoot, '.env')) ?? {};
    if (!(dotenv.DEPLOYER_KEY ?? '').trim()) die('DEPLOYER_KEY is not set in .env');
    secrets = [dotenv.DEPLOYER_KEY];
    signer = await startSigner(dotenv, allow);
    if (lc(signer.address) !== lc(deployer)) die(`DEPLOYER_KEY is for ${signer.address}, not the deployer ${deployer}`);
    say(`signer       ready for ${signer.address} (key read from .env, not shown)`);
  }
  const txs = [];
  const receipt = async (hash, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 90_000) {
      const r = await rpcCall(rpc, 'eth_getTransactionReceipt', [hash]);
      if (r) return r;
      await sleep(500);
    }
    die(`${label}: no receipt for ${hash} after 90 s`);
  };
  const send = async (purpose, to, data) => {
    await requireChain(rpc);
    if (!allow.map(lc).includes(lc(to))) die(`refusing a tx to ${to}`);
    let hash;
    if (args.fork) {
      hash = await rpcCall(rpc, 'eth_sendTransaction', [{ from: deployer, to, data }]);
    } else {
      const nonce = BigInt(await rpcCall(rpc, 'eth_getTransactionCount', [deployer, 'pending']));
      const est = BigInt(await rpcCall(rpc, 'eth_estimateGas', [{ from: deployer, to, data }]));
      const blk = await rpcCall(rpc, 'eth_getBlockByNumber', ['latest', false]);
      const base = BigInt(blk.baseFeePerGas ?? (await rpcCall(rpc, 'eth_gasPrice')));
      let tip = 0n;
      try {
        tip = BigInt(await rpcCall(rpc, 'eth_maxPriorityFeePerGas', [], { retries: 0 }));
      } catch {
        tip = 0n;
      }
      const fees = chooseFees(base, tip, BigInt(Math.round(args.maxFeeGwei * GWEI)));
      const tx = { chainId: TESTNET_CHAIN_ID, nonce: nonce.toString(), to, data, gas: ((est * 13n) / 10n + 10_000n).toString(), maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() };
      const signed = await signer.sign(tx);
      hash = await rpcCall(rpc, 'eth_sendRawTransaction', [signed.raw], { retries: 0 });
      if (lc(hash) !== lc(signed.hash)) say(`WARN         node returned ${hash}, signer computed ${signed.hash}`);
    }
    const r = await receipt(hash, purpose);
    const rec = { purpose, hash, block: Number(BigInt(r.blockNumber)), status: Number(BigInt(r.status)), gasUsed: Number(BigInt(r.gasUsed)) };
    txs.push(rec);
    say(`  tx ${purpose}: ${hash} block ${rec.block} status ${rec.status} gas ${rec.gasUsed}`);
    if (rec.status !== 1) die(`${purpose} reverted (${hash})`);
    return r;
  };

  let breached = false;
  let result = null;
  try {
    if (needMint) await send(`mint ${fmtUsdc(mintAmt)} mUSDC`, usdc, calldata('mint', [deployer, mintAmt]));
    if (needPos) {
      await send(`setPosition ${args.coin} long szi ${plannedPos.szi} entryNtl ${plannedPos.entryNtl} lev ${plannedPos.leverage}`, positionSource, calldata('setPosition', [deployer, perpIndex, plannedPos.szi, plannedPos.entryNtl, plannedPos.leverage]));
    }
    await send(`setPrice ${args.coin} ${refPx} (${args.fork ? 'real mock price' : 'live oracle'})`, priceSource, calldata('setPrice', [perpIndex, refPx]));

    // Quote: the engine caches a pool spot for 2 s, so wait it out and check spotRef is the price just set.
    let quote = null;
    const want = { buyer: deployer, perpIndex, isLong, level, payout: args.payout, spotRef: refPx, pool };
    for (let attempt = 1; attempt <= 3 && !quote; attempt++) {
      await sleep(3_000);
      const res = await fetch(`${args.engine}/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ buyer: deployer, pool, perpIndex, isLong, level: Number(level), payout: Number(args.payout), durationSec: args.durationSec }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.json();
      if (!res.ok) die(`engine /quote ${res.status}: ${body.error}: ${body.reason}`);
      const problems = checkQuote(body, want);
      if (!problems.length) quote = body;
      else if (attempt === 3 || !problems.every((p) => p.startsWith('spotRef'))) die(`quote rejected: ${problems.join('; ')}`);
      else say(`quote        ${problems.join('; ')}; retrying`);
    }
    const q = quote.quote;
    say(`quote        premium ${fmtUsdc(q.premium)} mUSDC for payout ${fmtUsdc(q.payout)} (touchProb ${quote.breakdown?.touchProb?.toFixed?.(4)}, floorApplied ${quote.breakdown?.floorApplied}), spotRef ${fmtPx(q.spotRef)}, level ${fmtPx(q.level)}, nonce ${q.nonce}, deadline in ${q.deadline - Math.floor(Date.now() / 1000)} s`);

    const left = q.deadline - Math.floor(Date.now() / 1000);
    if (left < 10) die(`the quote expires in ${left} s, too soon to approve and buy; nothing was bought, re-run`);
    await send(`approve ${fmtUsdc(q.premium)} mUSDC (exact premium)`, usdc, calldata('approve', [pool, BigInt(q.premium)]));
    const buyR = await send(`buyCover payout ${fmtUsdc(q.payout)} premium ${fmtUsdc(q.premium)}`, pool, buyCoverCalldata(q, quote.signature));
    const coverId = coverIdFromReceipt(buyR, pool);
    if (coverId === null) die('buyCover receipt has no CoverPurchased log');
    const cover0 = decodeCover(await ethCall(rpc, pool, calldata('getCover', [coverId])));
    say(`cover        #${coverId} ${cover0.status}, level ${fmtPx(cover0.level)}, expiry ${cover0.expiry}`);
    if (cover0.status !== 'Active') die(`cover ${coverId} is ${cover0.status}, not Active`);

    // Fork: a read-only keeper against the fork shows the keeper's own decision (it cannot send without a key).
    let dryKeeper = null;
    if (args.fork) dryKeeper = await startDryKeeper(rpc, pool, coverId, args.waitS);

    breached = true;
    const priceR = await send(`setPrice ${args.coin} ${breachPx} (breach: ${DEFAULTS.breachBps} bps below level ${level})`, priceSource, calldata('setPrice', [perpIndex, breachPx]));
    const priceSeen = Date.now();
    const priceBlock = await rpcCall(rpc, 'eth_getBlockByNumber', [priceR.blockNumber, false]);

    let cover = cover0;
    let paidSeen = null;
    let dryDecided = false; // fork: the read-only keeper's decision is in, no point waiting longer
    dryKeeper?.result.then((l) => (dryDecided = !!l));
    while (Date.now() - priceSeen < args.waitS * 1000 && !dryDecided) {
      await sleep(1_000);
      cover = decodeCover(await ethCall(rpc, pool, calldata('getCover', [coverId])));
      if (cover.status !== 'Active') {
        paidSeen = Date.now();
        break;
      }
    }
    let selfTriggered = false;
    if (cover.status !== 'Paid') {
      if (cover.status !== 'Active') die(`cover ${coverId} is ${cover.status}`);
      const waited = ((Date.now() - priceSeen) / 1000).toFixed(0);
      if (args.fork) say(`fork         the live keeper does not watch the fork; cover #${coverId} still Active ${waited} s after the breach`);
      else say(`KEEPER DID NOT TRIGGER cover #${coverId} within ${args.waitS} s of the breach (block ${Number(BigInt(priceR.blockNumber))}).`);
      if (!args.selfTrigger) die('not triggering it from here (no --self-trigger). Check the keeper; the price is reset below.');
      say('--self-trigger: the deployer triggers now. This run is NOT an F9 proof.');
      await send(`trigger(${coverId}) by the deployer (self-trigger, NOT F9)`, pool, calldata('trigger', [coverId]));
      selfTriggered = true;
      paidSeen = Date.now();
      cover = decodeCover(await ethCall(rpc, pool, calldata('getCover', [coverId])));
      if (cover.status !== 'Paid') die(`cover ${coverId} is ${cover.status} after the self-trigger`);
    }

    // Find the trigger tx by scanning blocks from the price block (no eth_getLogs: the log node lags).
    let trigTx = null;
    let trigBlock = null;
    const from = Number(BigInt(priceR.blockNumber));
    let n = from + 1;
    for (let attempt = 0; attempt < 30 && !trigTx && n <= from + 900; attempt++) {
      const headN = Number(BigInt(await rpcCall(rpc, 'eth_blockNumber')));
      for (; n <= Math.min(headN, from + 900) && !trigTx; n++) {
        const b = await rpcCall(rpc, 'eth_getBlockByNumber', [`0x${n.toString(16)}`, true]);
        const t = findTriggerTx(b, pool, coverId);
        if (t) [trigTx, trigBlock] = [t, b];
      }
      if (!trigTx) await sleep(1_000);
    }
    if (!trigTx) die(`cover ${coverId} is Paid but no trigger(${coverId}) tx was found from block ${from}`);
    const trigR = await receipt(trigTx.hash, 'trigger');
    const d = decodeTriggerReceipt(trigR, { pool, usdc, buyer: deployer });
    const trigRec = { purpose: `trigger(${coverId}) by ${selfTriggered ? 'the deployer (self-trigger)' : 'the keeper'}`, hash: trigTx.hash, block: Number(BigInt(trigR.blockNumber)), status: Number(BigInt(trigR.status)), gasUsed: Number(BigInt(trigR.gasUsed)), from: trigTx.from };
    if (!selfTriggered) {
      txs.push(trigRec);
      say(`  tx ${trigRec.purpose}: ${trigRec.hash} block ${trigRec.block} status ${trigRec.status} gas ${trigRec.gasUsed}`);
    }
    const problems = [];
    if (d.coverId !== coverId) problems.push(`CoverTriggered for cover ${d.coverId}, expected ${coverId}`);
    if (!selfTriggered && lc(d.caller) !== lc(keeper)) problems.push(`trigger caller ${d.caller} is not the keeper ${keeper}`);
    if (d.payoutTransfer !== args.payout) problems.push(`mUSDC Transfer pool -> deployer is ${d.payoutTransfer}, expected ${args.payout}`);
    if (d.deferred) problems.push('PayoutDeferred emitted');
    if (d.breaker) problems.push('LossBreakerTripped emitted (pool paused)');
    const blockDelta = Number(BigInt(trigBlock.timestamp) - BigInt(priceBlock.timestamp));
    const timing = {
      priceBlock: from,
      triggerBlock: trigRec.block,
      blocks: trigRec.block - from,
      blockTimestampDeltaS: blockDelta,
      wallClockToPaidSeenS: Number(((paidSeen - priceSeen) / 1000).toFixed(1)),
    };
    say(`trigger      cover #${coverId} Paid by ${d.caller} at oracle ${fmtPx(d.oraclePx)}; payout Transfer ${fmtUsdc(d.payoutTransfer ?? 0n)} mUSDC pool -> deployer`);
    say(`timing       price block ${from} -> trigger block ${trigRec.block} (${timing.blocks} blocks, ${blockDelta} s by block timestamps; seen Paid ${timing.wallClockToPaidSeenS} s after the price receipt)`);
    if (dryKeeper) {
      const line = await dryKeeper.result;
      say(line ? `fork keeper  read-only keeper decided: ${line}` : 'fork keeper  the read-only keeper printed no trigger decision');
    }
    if (problems.length) die(`checks failed: ${problems.join('; ')}`);
    result = { coverId, q, quote, d, timing, selfTriggered, trigRec, dryKeeper: dryKeeper ? await dryKeeper.result : null };
  } finally {
    if (breached && args.reset) {
      try {
        const px = args.fork ? refPx : await liveOracle();
        await send(`setPrice ${args.coin} ${px} (reset to ${args.fork ? 'the reference price' : 'the live oracle'})`, priceSource, calldata('setPrice', [perpIndex, px]));
      } catch (e) {
        say(`WARN         price reset failed: ${e.message}. Reset it by hand before the next demo.`);
      }
    }
  }

  // -- record --------------------------------------------------------------------------------------
  const { coverId, q, quote, d, timing, selfTriggered } = result;
  const key = e2eKey(date, selfTriggered, mock);
  const block = jsonable({
    proof: selfTriggered ? 'NOT an F9 proof: the deployer triggered (--self-trigger)' : 'F9: the keeper triggered the breached cover',
    note: `MOCK v2 pool, perp ${args.coin}=${perpIndex}; deployer as buyer (mock position source); mock price set to ${args.fork ? "the real chain's mock price (the price the engine quotes against)" : 'the live testnet oracle'}, cover bought from an engine quote, price moved ${DEFAULTS.breachBps} bps past the level; by scripts/e2e-mock-v2.mjs at ${git(['rev-parse', '--short', 'HEAD']).out}${args.fork ? ' on a local anvil fork' : ''}`,
    wallet: deployer,
    keeper,
    coverId,
    quote: { spotRef: q.spotRef, level: q.level, payout: q.payout, premium: q.premium, durationSec: args.durationSec, expiry: q.expiry, nonce: q.nonce, touchProb: quote.breakdown?.touchProb, floorApplied: quote.breakdown?.floorApplied, spotSource: quote.breakdown?.spotSource },
    trigger: { caller: d.caller, oraclePx: d.oraclePx, payoutTransfer: d.payoutTransfer },
    timing,
    ...(args.fork ? { forkKeeper: result.dryKeeper ?? 'the read-only keeper printed no trigger decision' } : {}),
    txs,
  });
  if (args.fork) {
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'numera-e2e-')), 'fork-e2e.json');
    writeFileSync(out, `${JSON.stringify({ [key]: block }, null, 2)}\n`);
    say(`wrote ${out} (fork run; deployments/ untouched)`);
  } else {
    const fresh = JSON.parse(readFileSync(v2File, 'utf8'));
    writeFileSync(v2File, `${JSON.stringify(mergeE2e(fresh, pool, key, block), null, 2)}\n`);
    say(`wrote ${path.relative(repoRoot, v2File)} pools.mock.${key}`);
  }
  say(selfTriggered ? 'DONE (self-triggered: NOT an F9 proof)' : `DONE: F9 keeper trigger in ${timing.blockTimestampDeltaS} s (block timestamps)`);
}

// Read-only keeper against the fork (no KEEPER_KEY); resolves with its "would send trigger(<id>)" line or null.
async function startDryKeeper(rpc, pool, coverId, waitS) {
  const py = venvPython(repoRoot);
  if (!py) die('engine venv not found (engine/.venv)');
  const env = { ...process.env, PYTHONUNBUFFERED: '1' };
  for (const k of ['DEPLOYER_KEY', 'QUOTE_SIGNER_KEY', 'KEEPER_KEY', 'NUMERA_RPCS']) delete env[k];
  const a = ['-m', 'numera_engine.keeper', '--dry-run', '--rpc', rpc, '--pool', pool, '--poll', '1', '--duration', String(waitS + 30), '--alert-logs-every', '0', '--deployments', path.join(repoRoot, 'deployments', 'testnet.json')];
  const child = spawn(py, a, { cwd: path.join(repoRoot, 'engine'), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.push(child);
  const re = new RegExp(`dry-run: would send trigger\\(${coverId}\\)`);
  let ready;
  const readyP = new Promise((r) => (ready = r));
  const result = new Promise((resolve) => {
    let done = false;
    const onLine = (l) => {
      if (/\[keeper\] poll ok\b/.test(l)) ready(true);
      if (!done && re.test(l)) {
        done = true;
        resolve(`${l.replace(/^.*?\[keeper\]/, '[keeper]')} (seen ${new Date().toISOString()})`);
      }
    };
    createInterface({ input: child.stdout }).on('line', onLine);
    createInterface({ input: child.stderr }).on('line', onLine);
    child.once('exit', () => {
      ready(false);
      if (!done) resolve(null);
    });
    setTimeout(() => !done && resolve(null), (waitS + 30) * 1000);
  });
  const ok = await Promise.race([readyP, sleep(60_000).then(() => false)]);
  say(ok ? 'fork keeper  read-only keeper polling the fork (1 s)' : 'WARN         read-only keeper on the fork printed no "poll ok" within 60 s');
  return { result };
}

main()
  .catch((e) => {
    console.error(scrub(`[e2e] ERROR: ${e instanceof Stop ? e.message : e.stack ?? e.message}`, secrets));
    process.exitCode = 1;
  })
  .finally(killAll);
