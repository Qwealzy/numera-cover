#!/usr/bin/env node
// Read-only environment diagnosis. Prints `[OK]/[WARN]/[FAIL] <check>: <detail>` lines; exit 1 on any FAIL.
// Nothing here signs or sends a transaction; only read RPC methods are called (scripts/lib/rpc.mjs refuses
// anything else). Secret values are never printed: .env keys are reported as set / empty / missing.
//
//   node scripts/doctor.mjs [--env <path to .env>] [--deployments <path>] [--deployments-v2 <path>] [--offline]
//
// --env defaults to <repo root>/.env (a worktree has none; pass the main checkout's .env).
// --deployments-v2 defaults to deployments/testnet-v2.json (CoverPool v2 pools; a missing file is one WARN).
// --offline skips every network check (RPC chain id, code, balances, quoteSigner, rate-limit probe).
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { venvPython } from './venv.mjs';
import { repoRoot, mainCheckout, forgePath, git, parseWorktrees } from './lib/tools.mjs';
import { readDotenv, exampleKeys, keyStatus } from './lib/env.mjs';
import { collectAddresses } from './lib/deployments.mjs';
import { loadV2, v2FileLines, checkV2Pools } from './lib/doctorv2.mjs';
import { makeClient, probe, engineTestnetRpcs, host, looksLikeMainnetRpc, TESTNET_CHAIN_ID, MAINNET_CHAIN_ID } from './lib/rpc.mjs';

// ---- args ----------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const OFFLINE = argv.includes('--offline');
const envPath = path.resolve(opt('--env', path.join(repoRoot, '.env')));
const depPath = path.resolve(opt('--deployments', path.join(repoRoot, 'deployments', 'testnet.json')));
const depV2Path = path.resolve(opt('--deployments-v2', path.join(repoRoot, 'deployments', 'testnet-v2.json')));

// ---- output --------------------------------------------------------------------------------------
const counts = { OK: 0, WARN: 0, FAIL: 0 };
function report(level, check, detail) {
  counts[level]++;
  console.log(`${`[${level}]`.padEnd(6)} ${check}: ${detail}`);
}
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const eqAddr = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// ---- deployments ---------------------------------------------------------------------------------
let dep = null;
if (!existsSync(depPath)) report('FAIL', 'deployments', `${path.relative(repoRoot, depPath)} not found`);
else {
  try {
    dep = JSON.parse(readFileSync(depPath, 'utf8'));
    const cid = Number(dep.chainId);
    if (cid === MAINNET_CHAIN_ID) report('FAIL', 'deployments chainId', `MAINNET 999 in ${path.basename(depPath)}. Numera is testnet only.`);
    else if (cid !== TESTNET_CHAIN_ID) report('FAIL', 'deployments chainId', `${dep.chainId}, expected 998`);
    else report('OK', 'deployments chainId', `998 (${path.basename(depPath)}, deployedAt ${dep.deployedAt ?? '?'}, commit ${dep.commit ?? '?'})`);
    if (looksLikeMainnetRpc(dep.rpc)) report('FAIL', 'deployments rpc', `MAINNET host ${host(dep.rpc)}`);
  } catch (e) {
    report('FAIL', 'deployments', `cannot parse ${depPath}: ${e.message}`);
  }
}
const v2 = loadV2(depV2Path);
for (const [level, check, detail] of v2FileLines(v2, depV2Path)) report(level, check, detail);
const addrs = dep ? collectAddresses(dep) : { contracts: [], eoas: [] };
const knownAddrs = [...addrs.contracts, ...addrs.eoas].map((a) => a.addr.toLowerCase());

// ---- .env ----------------------------------------------------------------------------------------
function envFileChecks(label, file, exampleFile, { addressKeys = [], chainKeys = [], rpcKeys = [] } = {}) {
  const ex = existsSync(exampleFile) ? exampleKeys(readFileSync(exampleFile, 'utf8')) : { required: [], optional: [] };
  const env = readDotenv(file);
  if (!env) return null;
  report('OK', label, `found ${file}`);
  for (const k of ex.required) {
    const s = keyStatus(env, k);
    const optionalEmpty = addressKeys.includes(k) && s !== 'set';
    report(s === 'set' || optionalEmpty ? 'OK' : 'WARN', `${label} ${k}`, optionalEmpty ? `${s} (optional; engine/app use deployments file)` : s);
  }
  for (const k of ex.optional) if (keyStatus(env, k) === 'set') report('OK', `${label} ${k}`, 'set (optional)');
  const extra = Object.keys(env).filter((k) => !ex.required.includes(k) && !ex.optional.includes(k));
  if (extra.length) report('OK', `${label} extra keys`, extra.join(', '));
  for (const k of addressKeys) {
    if (keyStatus(env, k) !== 'set') continue;
    if (!ADDR.test(env[k])) report('WARN', `${label} ${k} value`, 'not a 0x address');
    else if (!knownAddrs.includes(env[k].toLowerCase())) report('WARN', `${label} ${k} value`, `${env[k]} is not in ${path.basename(depPath)} (stale address?)`);
    else {
      const hit = addrs.contracts.find((a) => eqAddr(a.addr, env[k]));
      report('OK', `${label} ${k} value`, `${env[k]} = deployments ${hit?.path ?? 'entry'}`);
    }
  }
  for (const k of chainKeys) {
    if (keyStatus(env, k) !== 'set') continue;
    const v = Number(env[k]);
    if (v === MAINNET_CHAIN_ID) report('FAIL', `${label} ${k}`, 'MAINNET 999. Numera is testnet only (998).');
    else if (v !== TESTNET_CHAIN_ID) report('WARN', `${label} ${k}`, `${env[k]} (expected 998)`);
    else report('OK', `${label} ${k}`, '998');
  }
  for (const k of rpcKeys) if (keyStatus(env, k) === 'set' && looksLikeMainnetRpc(env[k])) report('FAIL', `${label} ${k}`, `MAINNET host ${host(env[k])}`);
  return env;
}

const env = envFileChecks('.env', envPath, path.join(repoRoot, '.env.example'), {
  addressKeys: ['POOL_ADDRESS', 'USDC_ADDRESS'],
  chainKeys: ['CHAIN_ID', 'NUMERA_CHAIN_ID'],
  rpcKeys: ['RPC_URL', 'NUMERA_RPC_URL'],
});
if (!env) {
  const alt = path.join(mainCheckout(), '.env');
  report('WARN', '.env', `not found at ${envPath}${alt !== envPath && existsSync(alt) ? ` (main checkout has one: --env ${alt})` : ''}`);
}

// app/.env and app/.env.local next to the .env given (Vite reads both; .env.local wins).
const appEnvDir = path.join(path.dirname(envPath), 'app');
const appEx = path.join(repoRoot, 'app', '.env.example');
let appSeen = false;
for (const f of ['.env', '.env.local']) {
  const e = envFileChecks(`app/${f}`, path.join(appEnvDir, f), appEx, { rpcKeys: ['VITE_RPC_URL'] });
  appSeen ||= !!e;
}
if (!appSeen) report('OK', 'app env', `no app/.env or app/.env.local under ${path.dirname(envPath)}; defaults from app/src/config.ts`);

// QUOTE_SIGNER_KEY -> address, via viem from app/node_modules (no new dependency). Key never printed.
function loadViemAccounts() {
  for (const dir of [path.join(repoRoot, 'app'), path.join(mainCheckout(), 'app')]) {
    if (!existsSync(path.join(dir, 'node_modules', 'viem'))) continue;
    try {
      return createRequire(path.join(dir, 'package.json'))('viem/accounts');
    } catch {
      /* try next */
    }
  }
  return null;
}
if (env && keyStatus(env, 'QUOTE_SIGNER_KEY') === 'set') {
  const viem = loadViemAccounts();
  if (!viem) report('WARN', 'QUOTE_SIGNER_KEY address', 'viem not found in app/node_modules; skipped (npm --prefix app ci)');
  else {
    let derived = null;
    try {
      const k = env.QUOTE_SIGNER_KEY.startsWith('0x') ? env.QUOTE_SIGNER_KEY : `0x${env.QUOTE_SIGNER_KEY}`;
      derived = viem.privateKeyToAccount(k).address;
    } catch {
      report('FAIL', 'QUOTE_SIGNER_KEY address', 'value is not a valid private key (value not shown)');
    }
    if (derived) {
      if (!dep?.quoteSigner) report('WARN', 'QUOTE_SIGNER_KEY address', `${derived}; deployments has no quoteSigner to compare`);
      else if (eqAddr(derived, dep.quoteSigner)) report('OK', 'QUOTE_SIGNER_KEY address', `${derived} = deployments quoteSigner`);
      else report('FAIL', 'QUOTE_SIGNER_KEY address', `${derived} != deployments quoteSigner ${dep.quoteSigner} (pools will reject its quotes)`);
    }
  }
}

// ---- toolchain -----------------------------------------------------------------------------------
function version(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
}
report(Number(process.versions.node.split('.')[0]) >= 20 ? 'OK' : 'WARN', 'node', `v${process.versions.node}`);
const forge = forgePath();
const fv = version(forge, ['--version']);
report(fv ? 'OK' : 'FAIL', 'forge', fv ? `${fv} (${forge})` : `'${forge}' not found (install Foundry: foundryup)`);
const py = venvPython(repoRoot);
const pv = py && version(py, ['--version']);
report(pv ? 'OK' : 'FAIL', 'engine venv', pv ? `${pv} (${py})` : 'engine/.venv not found (python -m venv engine/.venv; pip install -e "engine[dev]")');
if (pv) {
  const mods = version(py, ['-c', 'import uvicorn, fastapi, eth_account; print("uvicorn fastapi eth_account importable")']);
  report(mods ? 'OK' : 'FAIL', 'engine deps', mods ?? 'uvicorn/fastapi/eth_account not importable in the venv');
}
const nm = path.join(repoRoot, 'app', 'node_modules');
report(existsSync(nm) ? 'OK' : 'WARN', 'app node_modules', existsSync(nm) ? nm : `missing at ${nm} (npm --prefix app ci)`);

// ---- leftover worktrees / branches (report only, never delete) -----------------------------------
const main = mainCheckout();
const wt = git(['worktree', 'list', '--porcelain'], main);
const merged = new Set(git(['branch', '--merged', 'main', '--format=%(refname:short)'], main).out.split(/\r?\n/).filter(Boolean));
const here = path.resolve(repoRoot).toLowerCase();
if (wt.ok) {
  const leftovers = parseWorktrees(wt.out).filter((w) => /[\\/]\.claude[\\/]worktrees[\\/]/.test(path.resolve(w.path)));
  for (const w of leftovers) {
    const self = path.resolve(w.path).toLowerCase() === here ? ' (this worktree)' : '';
    report('WARN', 'worktree', `${path.relative(main, w.path)} [${w.branch || 'detached'}] ${w.branch && merged.has(w.branch) ? 'merged into main' : 'NOT merged into main'}${self}`);
  }
  if (!leftovers.length) report('OK', 'worktrees', 'none under .claude/worktrees/');
}
const branches = git(['branch', '--list', 'worktree-agent-*', '--format=%(refname:short)'], main).out.split(/\r?\n/).filter(Boolean);
for (const b of branches) report('WARN', 'branch', `${b} ${merged.has(b) ? 'merged into main' : 'NOT merged into main'}`);
if (!branches.length) report('OK', 'branches', 'no worktree-agent-* branches');

// ---- network -------------------------------------------------------------------------------------
async function network() {
  const fallbacks = engineTestnetRpcs(repoRoot);
  // url -> labels (the same URL is often listed in several places; query it once)
  const candidates = new Map();
  const add = (label, url) => url && candidates.set(url, [...(candidates.get(url) ?? []), label]);
  add('deployments rpc', dep?.rpc);
  add('.env RPC_URL', env?.RPC_URL);
  for (const u of fallbacks) add('engine fallback', u);

  // chain id per endpoint (each endpoint on its own; a fallback answering would hide a wrong URL)
  const good = [];
  for (const [url, labels] of candidates) {
    const label = labels.join(' + ');
    const onlyFallback = labels.every((l) => l === 'engine fallback');
    try {
      const { result } = await makeClient([url], { retries: 3 }).call('eth_chainId');
      const id = parseInt(result, 16);
      if (id === MAINNET_CHAIN_ID) report('FAIL', `chainId ${label}`, `MAINNET 999 at ${host(url)}. Testnet only; fix the URL.`);
      else if (id !== TESTNET_CHAIN_ID) report('FAIL', `chainId ${label}`, `${id} (${result}) at ${host(url)}, expected 998`);
      else {
        report('OK', `chainId ${label}`, `998 (0x3e6) at ${host(url)}`);
        good.push(url);
      }
    } catch (e) {
      report(onlyFallback ? 'WARN' : 'FAIL', `chainId ${label}`, `${host(url)}: ${e.message}`);
    }
  }
  if (!good.length) {
    report('FAIL', 'rpc', 'no testnet RPC answered; skipping on-chain checks');
    return;
  }

  // rate-limit probe on the primary endpoint
  const primary = good[0];
  const probes = [];
  for (let i = 0; i < 10; i++) probes.push(await probe(primary));
  const okN = probes.filter((p) => p.ok).length;
  const limN = probes.filter((p) => p.limited).length;
  const lat = probes.filter((p) => p.ok).map((p) => p.ms).sort((a, b) => a - b);
  const med = lat.length ? lat[Math.floor(lat.length / 2)] : 0;
  const errN = 10 - okN - limN;
  report(limN || errN ? 'WARN' : 'OK', 'rpc rate-limit probe', `${host(primary)}: 10 x eth_blockNumber -> ${okN} ok, ${limN} rate-limited, ${errN} other errors; latency median ${med} ms, max ${lat.at(-1) ?? 0} ms`);

  const client = makeClient(good, { retries: 3 });
  const limit = 3; // small concurrency; the official RPC rate-limits bursts
  async function pmap(items, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }));
    return out;
  }

  await pmap(addrs.contracts, async (c) => {
    try {
      const { result, url } = await client.call('eth_getCode', [c.addr, 'latest']);
      const bytes = (result.length - 2) / 2;
      report(bytes > 0 ? 'OK' : 'FAIL', `code ${c.path}`, `${c.addr} ${bytes > 0 ? `${bytes} bytes` : 'NO CODE'} (via ${host(url)})`);
    } catch (e) {
      report('FAIL', `code ${c.path}`, `${c.addr}: ${e.message}`);
    }
  });

  await pmap(addrs.eoas, async (a) => {
    try {
      const { result, url } = await client.call('eth_getBalance', [a.addr, 'latest']);
      const wei = BigInt(result);
      const hype = Number(wei / 10n ** 12n) / 1e6;
      const needsGas = a.path === 'keeper' || a.path === 'deployer';
      report(wei === 0n && needsGas ? 'WARN' : 'OK', `balance ${a.path}`, `${a.addr} ${hype} HYPE${wei === 0n && needsGas ? ' (needs testnet HYPE for gas)' : ''} (via ${host(url)})`);
    } catch (e) {
      report('WARN', `balance ${a.path}`, `${a.addr}: ${e.message}`);
    }
  });

  // quoteSigner() = keccak256("quoteSigner()")[0:4] = 0xf413bdb3 (`cast sig "quoteSigner()"`)
  const pools = Object.entries(dep?.pools ?? {}).filter(([, p]) => ADDR.test(p?.pool ?? ''));
  await pmap(pools, async ([name, p]) => {
    try {
      const { result, url } = await client.call('eth_call', [{ to: p.pool, data: '0xf413bdb3' }, 'latest']);
      const onchain = `0x${result.slice(-40)}`;
      if (eqAddr(onchain, dep.quoteSigner)) report('OK', `quoteSigner pools.${name}`, `${onchain} = deployments quoteSigner (via ${host(url)})`);
      else report('FAIL', `quoteSigner pools.${name}`, `on-chain ${onchain} != deployments ${dep.quoteSigner}`);
    } catch (e) {
      report('FAIL', `quoteSigner pools.${name}`, e.message);
    }
  });

  // CoverPool v2 pools (deployments/testnet-v2.json): code, paused() false, totalAssets(), coverCount().
  if (v2.pools?.length) await checkV2Pools(client, v2.pools, report, host);

  const used = [...client.answeredBy.entries()].map(([u, n]) => `${host(u)} x${n}`).join(', ');
  report(client.answeredBy.size > 1 || !client.answeredBy.has(primary) ? 'WARN' : 'OK', 'rpc answered by', used || 'none');
}

if (OFFLINE) report('OK', 'network', 'skipped (--offline)');
else await network();

console.log(`doctor: ${counts.OK} ok, ${counts.WARN} warn, ${counts.FAIL} fail`);
process.exitCode = counts.FAIL ? 1 : 0; // not process.exit(): see scripts/dev.mjs (Node 24 Windows libuv assert after fetch)
