#!/usr/bin/env node
// One-command local start: engine Quote API (uvicorn) + app (Vite dev server), from .env.
// Works the same from Windows PowerShell 5.1, pwsh, cmd and Git Bash: `node scripts/dev.mjs`.
//
//   node scripts/dev.mjs [--env <path>] [--engine-only | --app-only] [--port <engine port, default 8000>]
//                        [--app-port <default 5173>] [--timeout <readiness seconds, default 90>] [--smoke]
//
// --env     .env file to load (default <repo root>/.env). KEY=VALUE lines; values already set in the shell win.
// --smoke   start, wait until both answer HTTP, make one request to each, stop everything, exit 0/1.
//
// Ctrl-C (or either child exiting) stops both; on Windows the whole child tree is killed with taskkill /T /F so
// no uvicorn/vite process is left behind. Testnet only: refuses CHAIN_ID / NUMERA_CHAIN_ID 999 and an RPC that
// is a mainnet host or answers chain id 999. Secret values are never printed.
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import readline from 'node:readline';
import path from 'node:path';
import { venvPython } from './venv.mjs';
import { repoRoot, mainCheckout } from './lib/tools.mjs';
import { readDotenv } from './lib/env.mjs';
import { probe, looksLikeMainnetRpc, host, MAINNET_CHAIN_ID } from './lib/rpc.mjs';

const isWin = process.platform === 'win32';
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(name);
const say = (msg) => console.log(`[dev] ${msg}`);
// Errors end the run by setting process.exitCode and letting the event loop drain, never process.exit():
// Node 24 on Windows aborts (libuv assertion, exit 127) when process.exit runs shortly after a fetch.
class DevExit extends Error {}
const die = (msg) => {
  throw new DevExit(msg);
};

const envPath = path.resolve(opt('--env', path.join(repoRoot, '.env')));
const enginePort = Number(opt('--port', '8000'));
const readyTimeoutS = Number(opt('--timeout', '90'));
const SMOKE = flag('--smoke');
const runEngine = !flag('--app-only');
const runApp = !flag('--engine-only');
const APP_PORT = Number(opt('--app-port', '5173')); // app/vite.config.ts default 5173 (strictPort); passed as --port
const children = [];

// Kill a child and everything it started (Windows: taskkill /T /F; POSIX: its process group).
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
  if (!runEngine && !runApp) die('--engine-only and --app-only exclude each other');
  for (const [n, v] of [['--port', enginePort], ['--app-port', APP_PORT]]) if (!Number.isInteger(v) || v < 1 || v > 65535) die(`${n} must be a TCP port number`);

  // ---- environment ---------------------------------------------------------------------------------
  const fileEnv = readDotenv(envPath);
  if (!fileEnv) {
    const alt = path.join(mainCheckout(), '.env');
    say(`no .env at ${envPath}${alt !== envPath && existsSync(alt) ? ` (main checkout has one: --env ${alt})` : ''}; using the shell environment only`);
  } else say(`loaded ${Object.keys(fileEnv).length} keys from ${envPath} (names: ${Object.keys(fileEnv).join(', ')})`);
  const env = { ...(fileEnv ?? {}), ...process.env }; // shell wins over .env

  const deployments = (() => {
    try {
      return JSON.parse(readFileSync(path.join(repoRoot, 'deployments', 'testnet.json'), 'utf8'));
    } catch {
      return null;
    }
  })();

  // ---- mainnet guard (before anything starts) ------------------------------------------------------
  for (const k of ['CHAIN_ID', 'NUMERA_CHAIN_ID']) if (Number(env[k]) === MAINNET_CHAIN_ID) die(`${k}=999 is mainnet. Numera runs on testnet (998) only.`);
  for (const k of ['RPC_URL', 'NUMERA_RPC_URL', 'VITE_RPC_URL']) if (env[k] && looksLikeMainnetRpc(env[k])) die(`${k} points at a mainnet host (${host(env[k])}). Testnet only.`);
  const rpcToCheck = env.NUMERA_RPC_URL || env.RPC_URL || deployments?.rpc;
  if (rpcToCheck) {
    const p = await probe(rpcToCheck, 'eth_chainId', { timeoutMs: 6000 });
    if (p.ok && parseInt(p.result, 16) === MAINNET_CHAIN_ID) die(`RPC ${rpcToCheck} answers chain id 999 (mainnet). Testnet only.`);
    if (p.ok) say(`RPC ${host(rpcToCheck)} chain id ${parseInt(p.result, 16)}`);
    else say(`WARN: RPC ${host(rpcToCheck)} chain id not confirmed (${p.limited ? 'rate-limited' : p.error}); continuing`);
  }

  if (runEngine && !(env.QUOTE_SIGNER_KEY ?? '').trim())
    die(`QUOTE_SIGNER_KEY is not set (looked in ${envPath} and the shell). The engine cannot sign quotes without it. Use --app-only to run only the app.`);

  const py = runEngine ? venvPython(repoRoot) : null;
  if (runEngine && !py) die('engine venv not found (engine/.venv). Create it: python -m venv engine/.venv; pip install -e "engine[dev]"');
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
  const engineEnv = { ...env, PYTHONUNBUFFERED: '1' };
  engineEnv.NUMERA_ENV ??= 'testnet';
  engineEnv.NUMERA_CHAIN_ID ??= env.CHAIN_ID || '998';
  if (env.RPC_URL) engineEnv.NUMERA_RPC_URL ??= env.RPC_URL;
  if (env.INFO_API) engineEnv.NUMERA_INFO_URL ??= env.INFO_API;
  // The engine's default CORS list only has the Vite default port; add the app origin actually used.
  if (runApp && APP_PORT !== 5173) engineEnv.NUMERA_CORS_ORIGINS ??= `http://localhost:${APP_PORT},http://127.0.0.1:${APP_PORT}`;
  if (Number(engineEnv.NUMERA_CHAIN_ID) === MAINNET_CHAIN_ID) die('engine chain id resolves to 999 (mainnet). Testnet only.');

  // App: point VITE_ENGINE_URL at the local engine unless app/.env* or the shell sets it.
  const engineUrl = `http://localhost:${enginePort}`;
  const appEnv = { ...env };
  const appDir = path.join(repoRoot, 'app');
  const exampleHasEngineUrl = /^VITE_ENGINE_URL=/m.test(existsSync(path.join(appDir, '.env.example')) ? readFileSync(path.join(appDir, '.env.example'), 'utf8') : '');
  const appFileSets = ['.env', '.env.local', '.env.development', '.env.development.local'].find((f) => readDotenv(path.join(appDir, f))?.VITE_ENGINE_URL);
  if (runApp && exampleHasEngineUrl && !appFileSets && !process.env.VITE_ENGINE_URL) appEnv.VITE_ENGINE_URL = engineUrl;
  const appEngineUrl = appEnv.VITE_ENGINE_URL ?? (appFileSets ? `(from app/${appFileSets})` : '(app default)');

  // ---- children ------------------------------------------------------------------------------------
  let stopping = false;
  let exitCode = 0;

  function pipe(stream, tag, out) {
    readline.createInterface({ input: stream }).on('line', (l) => out.write(`${tag} ${l}\n`));
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
  } else say('press Ctrl-C to stop both');
}

main().catch((e) => {
  if (!(e instanceof DevExit)) throw e;
  console.error(`[dev] ERROR: ${e.message}`);
  for (const c of children) killTree(c);
  process.exitCode = 1;
});
