#!/usr/bin/env node
// CoverPool v2 deploy wrapper (ARCHITECTURE §5.9). The founder runs it; works from PowerShell, cmd and Git Bash.
//
//   node scripts/deploy-v2.mjs --dry-run --yes [--mode mock|hypercore]   # local anvil (31337), end to end
//   node scripts/deploy-v2.mjs [--mode hypercore|mock]                    # testnet (998): prints the plan only
//   node scripts/deploy-v2.mjs --yes [--mode hypercore|mock]              # testnet (998): deploys
//
// Before a testnet run: `python scripts/big-blocks.py on` (the pool needs ~4.8M gas, above the 3M small block),
// and `python scripts/big-blocks.py off` afterwards.
//
// Safety: refuses any chain but 998 (or 31337 with --dry-run), checked with eth_chainId on the RPC it uses
// before and after the broadcast; refuses a known mainnet RPC host without a network call. .env is loaded into
// the forge child's environment only: DEPLOYER_KEY is never put on a command line and never printed (Deploy.s.sol
// reads it with vm.envUint). The dry run never passes DEPLOYER_KEY; it uses anvil's unlocked account 0.
// forge runs with --skip-simulation --slow: forge's local pass uses precompile stand-ins, and its per-transaction
// eth_estimateGas makes the node run the real HyperCore precompiles (an invalid perp aborts before gas is spent).
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { repoRoot, forgePath, git } from './lib/tools.mjs';
import { readDotenv } from './lib/env.mjs';
import { host, looksLikeMainnetRpc } from './lib/rpc.mjs';
import {
  USAGE,
  LOCAL_CHAIN_ID,
  TESTNET_CHAIN_ID,
  childEnv,
  forgeArgs,
  mergeV2,
  parseDeployArgs,
  parseLimits,
  perpList,
  standinFromInfo,
  summarizeBroadcast,
} from './lib/deployv2.mjs';

const say = (m) => console.log(`[deploy-v2] ${m}`);
class Stop extends Error {}
const die = (m) => {
  throw new Stop(m);
};
const bin = (name) => {
  const p = path.join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? `${name}.exe` : name);
  return existsSync(p) ? p : name;
};
const contractsDir = path.join(repoRoot, 'contracts');
const INFO_API = 'https://api.hyperliquid-testnet.xyz/info';
let anvil = null;

async function rpcCall(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function chainIdOf(url) {
  return Number(BigInt(await rpcCall(url, 'eth_chainId')));
}

async function requireChain(url, want) {
  if (looksLikeMainnetRpc(url)) die(`refusing ${host(url)}: a mainnet RPC host`);
  let id;
  try {
    id = await chainIdOf(url);
  } catch (e) {
    die(`eth_chainId failed on ${host(url)}: ${e.message}`);
  }
  if (id !== want) die(`${host(url)} answers chain ${id}; this run needs ${want}. Nothing was sent.`);
  return id;
}

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

async function startAnvil() {
  const port = await freePort();
  anvil = spawn(bin('anvil'), ['--port', String(port), '--chain-id', String(LOCAL_CHAIN_ID), '--silent'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await chainIdOf(url);
      return url;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  die('anvil did not start');
}

function stopAnvil() {
  if (!anvil?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(anvil.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else anvil.kill('SIGTERM');
  anvil = null;
}

function castCall(rpc, to, sig, args = []) {
  const r = spawnSync(bin('cast'), ['call', to, sig, ...args, '--rpc-url', rpc, '--json'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) die(`cast call ${sig} failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  const v = JSON.parse(r.stdout);
  return Array.isArray(v) && v.length === 1 ? v[0] : v;
}

function readBack(rpc, pool, perps) {
  const c = (sig, args) => castCall(rpc, pool, sig, args);
  return {
    owner: c('owner()(address)'),
    quoteSigner: c('quoteSigner()(address)'),
    guardian: c('guardian()(address)'),
    asset: c('asset()(address)'),
    priceSource: c('priceSource()(address)'),
    positionSource: c('positionSource()(address)'),
    configDelay: Number(c('configDelay()(uint64)')),
    withdrawDelay: Number(c('withdrawDelay()(uint64)')),
    claimWindow: Number(c('claimWindow()(uint64)')),
    configGrace: Number(c('CONFIG_GRACE()(uint64)')),
    strict: c('strict()(bool)') === true || c('strict()(bool)') === 'true',
    paused: c('paused()(bool)') === true || c('paused()(bool)') === 'true',
    limits: parseLimits(c('limits()((uint16,uint16,uint64,uint16,uint256,uint16,uint16,uint32,uint16,uint16,uint16))')),
    perps: Object.fromEntries(
      perps.map(({ name, index }) => {
        const allowed = c('perpAllowed(uint32)(bool)', [String(index)]);
        return [name, { index, allowed: allowed === true || allowed === 'true' }];
      }),
    ),
  };
}

async function main() {
  const args = parseDeployArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const deployments = JSON.parse(readFileSync(path.join(repoRoot, 'deployments', 'testnet.json'), 'utf8'));
  const perps = perpList(deployments.perps);
  const dotenv = readDotenv(path.join(repoRoot, '.env')) ?? {};
  const want = args.dryRun ? LOCAL_CHAIN_ID : TESTNET_CHAIN_ID;

  if (!args.dryRun) {
    if (!dotenv.DEPLOYER_KEY) die('DEPLOYER_KEY is not set in .env');
    if (args.rpc && args.rpc !== deployments.rpc) say(`using --rpc ${host(args.rpc)} instead of ${host(deployments.rpc)}`);
  }
  const rpc = args.rpc ?? (args.dryRun ? await startAnvil() : deployments.rpc);
  await requireChain(rpc, want);

  // Stand-in / mock prices: --standin-px, else the testnet Info API (read-only).
  let px;
  if (args.standinPx) {
    if (args.standinPx.length !== perps.length) die(`--standin-px needs ${perps.length} values (one per perp)`);
    px = args.standinPx;
  } else {
    const res = await fetch(INFO_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      signal: AbortSignal.timeout(15_000),
    });
    px = standinFromInfo(await res.json(), perps);
  }

  const vars = {
    QUOTE_SIGNER: deployments.quoteSigner,
    PERPS: perps.map((p) => p.index).join(','),
    MODE: args.mode,
    STANDIN_PX6: args.mode === 'hypercore' ? px.join(',') : undefined,
    MOCK_PX6: args.mode === 'mock' ? px.join(',') : undefined,
    USDC: args.dryRun ? undefined : deployments.usdc?.address,
    GUARDIAN: dotenv.GUARDIAN,
    OWNER: dotenv.OWNER,
  };
  const outLabel = args.dryRun ? `${tmpdir()}${path.sep}numera-v2-*${path.sep}local-v2.json (temp)` : path.join(repoRoot, 'deployments', 'testnet-v2.json');

  say('PLAN');
  say(`  chain        ${want} (${args.dryRun ? 'local anvil, dry run' : 'testnet'}) via ${host(rpc)}`);
  say(`  mode         ${args.mode}`);
  say(`  perps        ${perps.map((p, i) => `${p.name}=${p.index} (${args.mode === 'hypercore' ? 'stand-in' : 'mock'} px6 ${px[i]})`).join(', ')}`);
  say(`  quoteSigner  ${vars.QUOTE_SIGNER}`);
  say(`  usdc         ${vars.USDC ?? 'new MockUSDC'}`);
  say(`  owner        ${vars.OWNER ?? 'the broadcaster'}`);
  say(`  guardian     ${vars.GUARDIAN ?? 'none (address 0)'}`);
  say('  delays       configDelay 600 s, withdrawDelay 600 s, claimWindow 3600 s, strict=false (testnet values)');
  say(`  broadcaster  ${args.dryRun ? 'anvil unlocked account 0' : 'DEPLOYER_KEY from .env (read inside the script)'}`);
  say(`  forge        script script/Deploy.s.sol --broadcast --skip-simulation --slow${args.dryRun ? ' --unlocked' : ''}`);
  say(`  writes       ${outLabel}`);
  if (!args.yes) {
    say('nothing sent: re-run with --yes to broadcast');
    return;
  }

  const runFile = path.join(contractsDir, 'broadcast', 'Deploy.s.sol', String(want), 'run-latest.json');
  const started = Date.now();
  const r = spawnSync(forgePath(), forgeArgs({ rpc, dryRun: args.dryRun, gasPrice: args.gasPrice }), {
    cwd: contractsDir,
    env: childEnv(process.env, dotenv, vars, { dryRun: args.dryRun }),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (r.status !== 0) {
    const tail = out.split('\n').filter((l) => /error|revert|fail/i.test(l)).slice(-6).join('\n');
    console.error(tail || out.split('\n').slice(-15).join('\n'));
    const hint =
      args.mode === 'hypercore' && args.dryRun
        ? ' (expected on anvil: the hypercore route stops at eth_estimateGas because anvil has no HyperCore precompiles)'
        : '';
    if (existsSync(runFile) && statSync(runFile).mtimeMs >= started) {
      const planned = summarizeBroadcast(JSON.parse(readFileSync(runFile, 'utf8')));
      say(`planned transactions: ${planned.txs.length}; to a precompile address: ${planned.precompileTxs.length}`);
      const sent = planned.txs.filter((t) => t.status !== null);
      if (sent.length) say(`already mined before the abort: ${sent.map((t) => `${t.name} ${t.function}`).join(', ')}`);
    }
    die(`forge aborted with exit ${r.status}${hint}. Check the broadcast folder before re-running.`);
  }

  await requireChain(rpc, want);
  const sum = summarizeBroadcast(JSON.parse(readFileSync(runFile, 'utf8')));
  if (sum.precompileTxs.length) die(`broadcast contains transactions to precompile addresses: ${sum.precompileTxs.join(', ')}`);
  const pool = sum.contracts.CoverPool;
  if (!pool) die('no CoverPool in the broadcast');
  const failed = sum.txs.filter((t) => t.status !== 1);
  if (failed.length) die(`transactions without a success receipt: ${failed.map((t) => t.hash).join(', ')}`);
  for (const t of sum.txs) say(`  tx ${t.name ?? '-'} ${t.function ?? ''} gas ${t.gasUsed} ${t.hash}`);

  const state = readBack(rpc, pool, perps);
  const block = {
    deployedAt: new Date().toISOString().slice(0, 10),
    commit: git(['rev-parse', '--short', 'HEAD']).out,
    chainId: want,
    mode: args.mode,
    pool,
    priceSource: state.priceSource,
    positionSource: state.positionSource,
    usdc: state.asset,
    config: { ...state, priceSource: undefined, positionSource: undefined, asset: undefined },
    txs: sum.txs,
  };
  const outFile = args.dryRun
    ? path.join(mkdtempSync(path.join(tmpdir(), 'numera-v2-')), 'local-v2.json')
    : path.join(repoRoot, 'deployments', 'testnet-v2.json');
  const existing = !args.dryRun && existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : null;
  writeFileSync(outFile, `${JSON.stringify(mergeV2(existing, args.mode, block, { replace: args.replace }), null, 2)}\n`);
  say(`pool ${pool}: owner ${state.owner}, signer ${state.quoteSigner}, guardian ${state.guardian}`);
  say(`limits ${JSON.stringify(state.limits)}`);
  say(`perps ${JSON.stringify(state.perps)}`);
  say(`wrote ${outFile}`);
}

main()
  .catch((e) => {
    console.error(`[deploy-v2] ERROR: ${e instanceof Stop ? e.message : e.stack ?? e.message}`);
    process.exitCode = 1;
  })
  .finally(stopAnvil);
