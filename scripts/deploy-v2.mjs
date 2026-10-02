#!/usr/bin/env node
// CoverPool v2 deploy wrapper (ARCHITECTURE §5.9). The founder runs it; works from PowerShell, cmd and Git Bash.
//
//   node scripts/deploy-v2.mjs --dry-run --yes [--mode mock|hypercore]   # local anvil (31337), end to end
//   node scripts/deploy-v2.mjs --fork --yes [--mode mock|hypercore]      # local anvil fork of testnet (998)
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
// It also runs with --disable-block-gas-limit: forge's local pass otherwise caps each transaction at the gas limit
// of the forked block (a 3M small block on HyperEVM) and the ~4.9M CoverPool creation runs out of gas there
// (2026-10-02 testnet run, "Failed to decode return value: 0x").
// Preflight, before the --yes check: eth_getCode on every existing contract the script calls (USDC), then the same
// forge command WITHOUT --broadcast against the testnet RPC (forge's local pass only; nothing is sent), so a
// plan-only run catches it too; with --fork the preflight still forks the real testnet RPC, not the 30M anvil.
// --fork and the preflight point FOUNDRY_BROADCAST at a temp folder, so they never touch contracts/broadcast/.../998.
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
  ANVIL_ACCOUNT0,
  BIG_BLOCK_GAS_LIMIT,
  LOCAL_CHAIN_ID,
  TESTNET_CHAIN_ID,
  childEnv,
  forgeArgs,
  hasCode,
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

// Local anvil on a free port. forkUrl: a fork of testnet with chain id 998, the big-block gas limit (anvil would
// otherwise copy the fork block's 3M) and auto-impersonation (the deployer broadcasts without a key).
async function startAnvil(forkUrl = null) {
  const port = await freePort();
  const a = ['--port', String(port), '--silent'];
  if (forkUrl) {
    a.push('--fork-url', forkUrl, '--chain-id', String(TESTNET_CHAIN_ID));
    a.push('--gas-limit', String(BIG_BLOCK_GAS_LIMIT), '--auto-impersonate');
  } else a.push('--chain-id', String(LOCAL_CHAIN_ID));
  anvil = spawn(bin('anvil'), a, { stdio: 'ignore', windowsHide: true });
  let exited = null;
  anvil.once('exit', (code) => (exited = code));
  const url = `http://127.0.0.1:${port}`;
  // A fork fetches the remote head first; give it up to 2 minutes (a busy public RPC can be slow).
  const deadline = Date.now() + (forkUrl ? 120_000 : 10_000);
  while (Date.now() < deadline && exited === null) {
    try {
      await chainIdOf(url);
      return url;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  die(exited !== null ? `anvil exited with code ${exited}${forkUrl ? ` (fork of ${host(forkUrl)} failed?)` : ''}` : 'anvil did not start');
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
  // local = nothing reaches a real chain: no DEPLOYER_KEY, broadcast through an unlocked anvil account, temp output.
  const local = args.dryRun || args.fork;
  let sender = null;

  if (!local) {
    if (!dotenv.DEPLOYER_KEY) die('DEPLOYER_KEY is not set in .env');
    if (args.rpc && args.rpc !== deployments.rpc) say(`using --rpc ${host(args.rpc)} instead of ${host(deployments.rpc)}`);
  }
  let rpc;
  let preflightRpc;
  if (args.fork) {
    const src = args.rpc ?? deployments.rpc;
    preflightRpc = src;
    await requireChain(src, TESTNET_CHAIN_ID); // the fork source must be testnet (refuses a mainnet host first)
    if (!/^0x[0-9a-fA-F]{40}$/.test(deployments.deployer ?? '')) die('deployments/testnet.json has no deployer address');
    sender = deployments.deployer;
    say(`starting an anvil fork of ${host(src)} (chain 998, gas limit ${BIG_BLOCK_GAS_LIMIT})`);
    rpc = await startAnvil(src);
  } else if (args.dryRun) {
    sender = ANVIL_ACCOUNT0;
    rpc = args.rpc ?? (await startAnvil());
  } else rpc = args.rpc ?? deployments.rpc;
  await requireChain(rpc, want);
  preflightRpc ??= rpc;

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
  const outLabel = local ? `${tmpdir()}${path.sep}numera-v2-*${path.sep}${args.fork ? 'fork' : 'local'}-v2.json (temp)` : path.join(repoRoot, 'deployments', 'testnet-v2.json');

  say('PLAN');
  const where = args.fork ? 'local anvil fork of testnet' : args.dryRun ? 'local anvil, dry run' : 'testnet';
  say(`  chain        ${want} (${where}) via ${host(rpc)}`);
  say(`  mode         ${args.mode}`);
  say(`  perps        ${perps.map((p, i) => `${p.name}=${p.index} (${args.mode === 'hypercore' ? 'stand-in' : 'mock'} px6 ${px[i]})`).join(', ')}`);
  say(`  quoteSigner  ${vars.QUOTE_SIGNER}`);
  say(`  usdc         ${vars.USDC ?? 'new MockUSDC'}`);
  say(`  owner        ${vars.OWNER ?? 'the broadcaster'}`);
  say(`  guardian     ${vars.GUARDIAN ?? 'none (address 0)'}`);
  say('  delays       configDelay 600 s, withdrawDelay 600 s, claimWindow 3600 s, strict=false (testnet values)');
  const who = args.fork
    ? `${sender} (deployer, impersonated on the fork)`
    : args.dryRun
      ? 'anvil unlocked account 0'
      : 'DEPLOYER_KEY from .env (read inside the script)';
  say(`  broadcaster  ${who}`);
  const fa = (broadcast, url = rpc) => forgeArgs({ rpc: url, unlockedSender: sender, gasPrice: args.gasPrice, broadcast });
  say(`  forge        ${fa(true).filter((x) => x !== rpc && x !== '--rpc-url').join(' ')}`);
  say(`  writes       ${outLabel}`);

  // Preflight 1: every existing contract the script calls must have code on this chain.
  if (vars.USDC) {
    let code;
    try {
      code = await rpcCall(rpc, 'eth_getCode', [vars.USDC, 'latest']);
    } catch (e) {
      die(`eth_getCode(USDC) failed on ${host(rpc)}: ${e.message}. Nothing was sent.`);
    }
    if (!hasCode(code)) die(`USDC ${vars.USDC} has no code on chain ${want}. Nothing was sent.`);
    say(`preflight    USDC has code (${(code.length - 2) / 2} bytes)`);
  }
  // Preflight 2: forge's local pass without --broadcast (nothing is sent); its files go to a temp folder.
  const env = childEnv(process.env, dotenv, vars, { dryRun: local });
  const tmpBroadcast = mkdtempSync(path.join(tmpdir(), 'numera-v2-broadcast-'));
  const forge = (argv, broadcastDir) =>
    spawnSync(forgePath(), argv, {
      cwd: contractsDir,
      env: broadcastDir ? { ...env, FOUNDRY_BROADCAST: broadcastDir } : env,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  const errorTail = (res) => {
    const lines = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.split('\n');
    const hits = lines.filter((l) => /error|revert|fail|outofgas/i.test(l)).slice(-8);
    return (hits.length ? hits : lines.slice(-15)).join('\n');
  };
  const pre = forge(fa(false, preflightRpc), path.join(tmpBroadcast, 'preflight'));
  if (pre.status !== 0) {
    console.error(errorTail(pre));
    die(`preflight: forge's local simulation failed (exit ${pre.status}). Nothing was sent.`);
  }
  say(`preflight    forge local simulation on ${host(preflightRpc)} OK (no broadcast)`);
  if (!args.yes) {
    say('nothing sent: re-run with --yes to broadcast');
    return;
  }

  // The fork run is chain 998 too: keep its broadcast files out of contracts/broadcast/Deploy.s.sol/998.
  const broadcastRoot = args.fork ? path.join(tmpBroadcast, 'fork') : path.join(contractsDir, 'broadcast');
  const runFile = path.join(broadcastRoot, 'Deploy.s.sol', String(want), 'run-latest.json');
  const started = Date.now();
  const r = forge(fa(true), args.fork ? broadcastRoot : null);
  if (r.status !== 0) {
    console.error(errorTail(r));
    const hint =
      args.mode === 'hypercore' && local
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
  const outFile = local
    ? path.join(mkdtempSync(path.join(tmpdir(), 'numera-v2-')), args.fork ? 'fork-v2.json' : 'local-v2.json')
    : path.join(repoRoot, 'deployments', 'testnet-v2.json');
  const existing = !local && existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : null;
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
