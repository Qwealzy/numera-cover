#!/usr/bin/env node
// One-command local start: engine Quote API (uvicorn) + app (Vite dev server) [+ keeper], from .env.
// Works the same from Windows PowerShell 5.1, pwsh, cmd and Git Bash: `node scripts/dev.mjs`.
//
//   node scripts/dev.mjs [--env <path>] [--engine-only | --app-only] [--port <engine port, default 8000>]
//                        [--app-port <default 5173>] [--timeout <readiness seconds, default 90>] [--smoke]
//                        [--allow-unverified-rpc] [--keeper | --keeper-only] [--keeper-dry-run]
//
// --env     .env file to load (default <repo root>/.env). KEY=VALUE lines; values already set in the shell win.
// --smoke   start, wait until both answer HTTP, make one request to each, stop everything, exit 0/1.
//           With the keeper: also wait for its first `[keeper] poll ok` line before READY.
// --keeper  also start the keeper (python -m numera_engine.keeper) as a third child, with KEEPER_KEY from
//           .env/shell and NUMERA_RPCS set to the RPC list verified below. --keeper-only starts the keeper alone;
//           --keeper-dry-run runs it read-only (--dry-run, KEEPER_KEY optional) and implies --keeper.
//
// Ctrl-C (or any child exiting) stops all; on Windows the whole child tree is killed with taskkill /T /F so
// no uvicorn/vite process is left behind. Testnet only: refuses CHAIN_ID / NUMERA_CHAIN_ID 999 and an RPC that
// is a mainnet host, and refuses to start unless every configured RPC answers chain id 998 (31337 local);
// --allow-unverified-rpc lets an unreachable RPC through with a WARN. Secret values are never printed.
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import readline from 'node:readline';
import path from 'node:path';
import { venvPython } from './venv.mjs';
import { repoRoot, mainCheckout } from './lib/tools.mjs';
import { readDotenv } from './lib/env.mjs';
import { makeClient, looksLikeMainnetRpc, host, engineTestnetRpcs, MAINNET_CHAIN_ID, TESTNET_CHAIN_ID } from './lib/rpc.mjs';
import { parseDevArgs, keeperSpawn, withoutKeys, KEEPER_READY_RE } from './lib/dev.mjs';

const LOCAL_CHAIN_ID = 31337; // anvil (network `local`)

const isWin = process.platform === 'win32';
const say = (msg) => console.log(`[dev] ${msg}`);
// Errors end the run by setting process.exitCode and letting the event loop drain, never process.exit():
// Node 24 on Windows aborts (libuv assertion, exit 127) when process.exit runs shortly after a fetch.
class DevExit extends Error {}
const die = (msg) => {
  throw new DevExit(msg);
};

let args = null;
try {
  args = parseDevArgs(process.argv.slice(2), { defaultEnvPath: path.join(repoRoot, '.env') });
} catch (e) {
  console.error(`[dev] ERROR: ${e.message}`);
  process.exitCode = 1;
}
const children = [];

// Kill a child and everything it started (Windows: taskkill /T /F; POSIX: its process group).
// POSIX: children run detached in their own group, so a SIGKILL of dev itself leaves them running (accepted; Windows is the target).
function killTree(c) {
  if (c.exited || !c.child.pid) return;
  if (isWin) spawnSync('taskkill', ['/pid', String(c.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(-c.child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        process.kill(-c.child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }, 3000).unref();
  }
}

async function main() {
  const envPath = path.resolve(args.envPath);
  const { enginePort, runEngine, runApp, runKeeper, keeperDryRun } = args;
  const readyTimeoutS = args.timeoutS;
  const SMOKE = args.smoke;
  const ALLOW_UNVERIFIED_RPC = args.allowUnverifiedRpc; // escape hatch: start even if an RPC does not answer (999 is still refused)
  const APP_PORT = args.appPort; // app/vite.config.ts default 5173 (strictPort); passed as --port

  // ---- environment ---------------------------------------------------------------------------------
  const fileEnv = readDotenv(envPath);
  if (!fileEnv) {
    const alt = path.join(mainCheckout(), '.env');
    say(`no .env at ${envPath}${alt !== envPath && existsSync(alt) ? ` (main checkout has one: --env ${alt})` : ''}; using the shell environment only`);
  } else say(`loaded ${Object.keys(fileEnv).length} keys from ${envPath} (names: ${Object.keys(fileEnv).join(', ')})`);
  const env = { ...(fileEnv ?? {}), ...process.env }; // shell wins over .env

  if (runKeeper && !keeperDryRun && !(env.KEEPER_KEY ?? '').trim())
    die(`KEEPER_KEY is not set (looked in ${envPath} and the shell). The keeper cannot send trigger/expire txs without it. Use --keeper-dry-run for a read-only keeper.`);

  const deployments = (() => {
    try {
      return JSON.parse(readFileSync(path.join(repoRoot, 'deployments', 'testnet.json'), 'utf8'));
    } catch {
      return null;
    }
  })();

  // ---- mainnet guard (before anything starts) ------------------------------------------------------
  // The chain-id probe is the real guard: every configured RPC must answer 998 (or 31337 for a local node).
  // Host-name checks only catch the obvious mainnet URLs early. URLs are printed as host only (API keys).
  const appDir = path.join(repoRoot, 'app');
  const APP_ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];
  const rpcs = new Map(); // url -> labels
  const addRpc = (label, url) => url && rpcs.set(url, [...(rpcs.get(url) ?? []), label]);
  if (runKeeper) for (const u of (env.NUMERA_RPCS ?? '').split(',')) addRpc('NUMERA_RPCS', u.trim());
  for (const k of ['NUMERA_RPC_URL', 'RPC_URL', 'VITE_RPC_URL']) addRpc(k, env[k]);
  for (const f of APP_ENV_FILES) addRpc(`app/${f} VITE_RPC_URL`, readDotenv(path.join(appDir, f))?.VITE_RPC_URL);
  addRpc('deployments rpc', deployments?.rpc);
  if (runKeeper) for (const u of engineTestnetRpcs(repoRoot)) addRpc('keeper fallback', u); // the keeper's failover list
  for (const k of ['CHAIN_ID', 'NUMERA_CHAIN_ID']) if (Number(env[k]) === MAINNET_CHAIN_ID) die(`${k}=999 is mainnet. Numera runs on testnet (998) only.`);
  for (const [url, labels] of rpcs) if (looksLikeMainnetRpc(url)) die(`${labels.join(', ')} points at a mainnet host (${host(url)}). Testnet only.`);
  const ALLOWED_CHAIN_IDS = [TESTNET_CHAIN_ID, LOCAL_CHAIN_ID];
  const verifiedRpcs = []; // url, chain id; handed to the keeper as NUMERA_RPCS in this priority order
  for (const [url, labels] of rpcs) {
    const label = `${labels.join(' + ')} (${host(url)})`;
    let id = null;
    try {
      // 4 retries, jittered 1-2-4-8 s backoff on -32005/429/5xx/transport errors, at most 15 s of waiting per RPC,
      // so a transient rate limit does not block the start; after that, fail closed.
      const { result } = await makeClient([url], { retries: 4, baseDelayMs: 1000, maxWaitMs: 15000, timeoutMs: 6000 }).call('eth_chainId');
      id = parseInt(result, 16);
    } catch (e) {
      if (!ALLOW_UNVERIFIED_RPC)
        die(`${label}: chain id not verified after retries (${e.message}). Refusing to start; fix the RPC, retry in a minute, or pass --allow-unverified-rpc to start anyway.`);
      say(`WARN: ${label}: chain id NOT verified (${e.message}); continuing because of --allow-unverified-rpc`);
      continue;
    }
    if (id === MAINNET_CHAIN_ID) die(`${label} answers chain id 999 (mainnet). Testnet only.`);
    if (!ALLOWED_CHAIN_IDS.includes(id)) die(`${label} answers chain id ${id}; expected ${ALLOWED_CHAIN_IDS.join(' or ')}.`);
    say(`RPC ${label} chain id ${id}`);
    verifiedRpcs.push({ url, id });
  }

  // Keeper: only RPCs that answered, all on the same chain as the first one (never mix 31337 and 998 in one
  // failover list). Fails early, naming KEEPER_KEY but never printing it, unless --keeper-dry-run.
  let keeper = null;
  if (runKeeper) {
    const keeperRpcs = verifiedRpcs.filter((r) => r.id === verifiedRpcs[0]?.id).map((r) => r.url);
    if (!keeperRpcs.length) die('no verified RPC for the keeper (every RPC was unverified). Fix the RPC and retry.');
    try {
      keeper = keeperSpawn({ repoRoot, env, rpcs: keeperRpcs, dryRun: keeperDryRun, host });
    } catch (e) {
      die(e.message);
    }
  }

  if (runEngine && !(env.QUOTE_SIGNER_KEY ?? '').trim())
    die(`QUOTE_SIGNER_KEY is not set (looked in ${envPath} and the shell). The engine cannot sign quotes without it. Use --app-only to run only the app.`);

  const py = runEngine || runKeeper ? venvPython(repoRoot) : null;
  if ((runEngine || runKeeper) && !py) die('engine venv not found (engine/.venv). Create it: python -m venv engine/.venv; pip install -e "engine[dev]"');
  if (runApp && !existsSync(path.join(repoRoot, 'app', 'node_modules'))) die('app/node_modules missing. Run: npm --prefix app ci');

  // Vite binds ::1 on Windows, uvicorn 127.0.0.1: a port is free only if both loopbacks are free.
  function canListen(port, hostAddr) {
    return new Promise((resolve) => {
      const s = createServer();
      s.once('error', (e) => resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT')); // no IPv6: fine
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(port, hostAddr);
    });
  }
  const portFree = async (port) => (await canListen(port, '127.0.0.1')) && (await canListen(port, '::1'));
  if (runEngine && !(await portFree(enginePort))) die(`port ${enginePort} is already in use (another engine?). Stop it or pass --port.`);
  if (runApp && !(await portFree(APP_PORT))) die(`port ${APP_PORT} is already in use (another Vite?). Stop it or pass --app-port.`);

  // Engine settings (engine/numera_engine/quote_api.py Settings.from_env). Values from .env/shell win.
  const engineEnv = { ...withoutKeys(env, ['KEEPER_KEY']), PYTHONUNBUFFERED: '1' };
  engineEnv.NUMERA_ENV ??= 'testnet';
  engineEnv.NUMERA_CHAIN_ID ??= env.CHAIN_ID || '998';
  if (env.RPC_URL) engineEnv.NUMERA_RPC_URL ??= env.RPC_URL;
  if (env.INFO_API) engineEnv.NUMERA_INFO_URL ??= env.INFO_API;
  // The engine's default CORS list only has the Vite default port; add the app origin actually used.
  if (runApp && APP_PORT !== 5173) engineEnv.NUMERA_CORS_ORIGINS ??= `http://localhost:${APP_PORT},http://127.0.0.1:${APP_PORT}`;
  if (Number(engineEnv.NUMERA_CHAIN_ID) === MAINNET_CHAIN_ID) die('engine chain id resolves to 999 (mainnet). Testnet only.');

  // App: point VITE_ENGINE_URL at the local engine unless app/.env* or the shell sets it.
  const engineUrl = `http://localhost:${enginePort}`;
  const appEnv = withoutKeys(env, ['KEEPER_KEY', 'QUOTE_SIGNER_KEY']); // Vite needs neither key
  const exampleHasEngineUrl = /^VITE_ENGINE_URL=/m.test(existsSync(path.join(appDir, '.env.example')) ? readFileSync(path.join(appDir, '.env.example'), 'utf8') : '');
  const appFileSets = APP_ENV_FILES.find((f) => readDotenv(path.join(appDir, f))?.VITE_ENGINE_URL);
  if (runApp && exampleHasEngineUrl && !appFileSets && !process.env.VITE_ENGINE_URL) appEnv.VITE_ENGINE_URL = engineUrl;
  const appEngineUrl = appEnv.VITE_ENGINE_URL ?? (appFileSets ? `(from app/${appFileSets})` : '(app default)');

  // ---- children ------------------------------------------------------------------------------------
  let stopping = false;
  let exitCode = 0;

  let keeperPollOk = false; // set by the first `[keeper] poll ok` line (smoke readiness)
  function pipe(stream, tag, out) {
    readline.createInterface({ input: stream }).on('line', (l) => {
      out.write(`${tag} ${l}\n`);
      if (tag === '[keeper]' && KEEPER_READY_RE.test(l)) keeperPollOk = true;
    });
  }

  function start(tag, cmd, args, opts) {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !isWin });
    const c = { tag, child, exited: false, code: null };
    children.push(c);
    pipe(child.stdout, tag, process.stdout);
    pipe(child.stderr, tag, process.stderr);
    child.on('error', (e) => {
      console.error(`${tag} failed to start: ${e.message}`);
      c.exited = true;
      stop(1);
    });
    child.on('exit', (code, sig) => {
      c.exited = true;
      c.code = code;
      if (!stopping) {
        say(`${tag} exited (${sig ?? `code ${code}`}); stopping the rest`);
        stop(code || 1);
      }
    });
    return c;
  }

  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    say('stopping...');
    for (const c of children) killTree(c);
    const t0 = Date.now();
    while (children.some((c) => !c.exited) && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
    for (const c of children) if (!c.exited) say(`WARN: ${c.tag} (pid ${c.child.pid}) did not exit`);
    say(`stopped (exit ${exitCode})`);
    process.exitCode = exitCode;
    process.removeAllListeners('SIGINT'); // let a second Ctrl-C end the process normally
  }
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(s, () => stop(0));
    } catch {
      /* signal not supported on this platform */
    }
  }

  if (runEngine) {
    say(`starting engine on ${engineUrl} (NUMERA_ENV=${engineEnv.NUMERA_ENV}, NUMERA_CHAIN_ID=${engineEnv.NUMERA_CHAIN_ID}, QUOTE_SIGNER_KEY set)`);
    start('[engine]', py, ['-m', 'uvicorn', 'numera_engine.quote_api:app', '--host', '127.0.0.1', '--port', String(enginePort)], {
      cwd: path.join(repoRoot, 'engine'),
      env: engineEnv,
    });
  }
  if (runApp) {
    // `npm run dev` is `vite`; run vite's bin with node directly when that is the script, so Ctrl-C does not hit
    // cmd.exe's "Terminate batch job (Y/N)?" prompt on Windows. Otherwise fall back to `npm run dev`.
    const devScript = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')).scripts?.dev ?? '';
    const viteBin = path.join(appDir, 'node_modules', 'vite', 'bin', 'vite.js');
    say(`starting app on http://localhost:${APP_PORT} (VITE_ENGINE_URL=${appEngineUrl})`);
    if (/^vite(\s|$)/.test(devScript) && existsSync(viteBin)) {
      start('[app]', process.execPath, [viteBin, ...devScript.split(/\s+/).slice(1), '--port', String(APP_PORT)], { cwd: appDir, env: appEnv });
    } else {
      start('[app]', 'npm', ['run', 'dev', '--', '--port', String(APP_PORT)], { cwd: appDir, env: appEnv, shell: isWin });
    }
  }

  if (runKeeper) {
    say(keeper.describe);
    start('[keeper]', py, keeper.args, { cwd: keeper.cwd, env: keeper.env });
  }

  // ---- readiness -----------------------------------------------------------------------------------
  async function get(url) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return { status: r.status, text: await r.text() };
    } catch {
      return null;
    }
  }
  async function waitFor(name, url) {
    const t0 = Date.now();
    while (!stopping && Date.now() - t0 < readyTimeoutS * 1000) {
      const r = await get(url);
      if (r && r.status < 500) return r;
      await new Promise((res) => setTimeout(res, 500));
    }
    if (!stopping) {
      say(`${name} did not answer ${url} within ${readyTimeoutS}s`);
      await stop(1);
    }
    return null;
  }

  const lines = [];
  if (runEngine) {
    const r = await waitFor('engine', `http://127.0.0.1:${enginePort}/health`);
    if (!r) await new Promise(() => {}); // stop() exits
    let h = {};
    try {
      h = JSON.parse(r.text);
    } catch {
      /* not JSON */
    }
    if (Number(h.chainId) === MAINNET_CHAIN_ID) {
      say('engine reports chainId 999 (mainnet); stopping');
      await stop(1);
      return;
    }
    lines.push(`engine  ${engineUrl}  /health ok=${h.ok} chainId=${h.chainId} signer=${h.signer} pool=${h.pool}`);
    if (h.ok !== true) say('WARN: engine /health ok=false (signer missing or chain not allowed)');
  }
  if (runApp) {
    const r = await waitFor('app', `http://localhost:${APP_PORT}/`);
    if (!r) await new Promise(() => {});
    lines.push(`app     http://localhost:${APP_PORT}/  (HTTP ${r.status}; engine URL ${appEngineUrl})`);
  }
  if (runKeeper && SMOKE) {
    const t0 = Date.now();
    while (!stopping && !keeperPollOk && Date.now() - t0 < readyTimeoutS * 1000) await new Promise((r) => setTimeout(r, 200));
    if (stopping) await new Promise(() => {}); // a child exited; stop() sets the exit code
    if (!keeperPollOk) {
      say(`keeper printed no "poll ok" line within ${readyTimeoutS}s`);
      await stop(1);
      return;
    }
    lines.push(`keeper  first poll ok after ${((Date.now() - t0) / 1000).toFixed(1)}s${keeperDryRun ? ' (dry run)' : ''}`);
  } else if (runKeeper) lines.push(`keeper  started${keeperDryRun ? ' (dry run)' : ''}; its poll ok / balance lines follow`);
  say('READY');
  for (const l of lines) say(`  ${l}`);

  if (SMOKE) {
    let ok = true;
    if (runEngine) {
      const r = await get(`http://127.0.0.1:${enginePort}/health`);
      say(`smoke: GET ${engineUrl}/health -> ${r ? `HTTP ${r.status} ${r.text}` : 'no answer'}`);
      ok &&= r?.status === 200;
    }
    if (runApp) {
      const r = await get(`http://localhost:${APP_PORT}/`);
      const title = /<title>([^<]*)<\/title>/i.exec(r?.text ?? '')?.[1];
      say(`smoke: GET http://localhost:${APP_PORT}/ -> ${r ? `HTTP ${r.status}, ${r.text.length} bytes, <title>${title ?? '?'}</title>` : 'no answer'}`);
      ok &&= r?.status === 200;
    }
    await stop(ok ? 0 : 1);
  } else say('press Ctrl-C to stop everything');
}

if (args) main().catch((e) => {
  if (!(e instanceof DevExit)) throw e;
  console.error(`[dev] ERROR: ${e.message}`);
  for (const c of children) killTree(c);
  process.exitCode = 1;
});
