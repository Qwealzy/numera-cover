// Pure helpers for scripts/dev.mjs (argument parsing, per-child environments), split out so they are unit-tested
// in lib.test.mjs. No side effects; secret values never appear in the returned descriptions.
import path from 'node:path';

const BOOL_FLAGS = ['--smoke', '--allow-unverified-rpc', '--engine-only', '--app-only', '--keeper', '--keeper-only', '--keeper-dry-run'];
const VALUE_FLAGS = ['--env', '--port', '--app-port', '--timeout'];

// Secrets each child must not inherit: the engine signs quotes, the keeper sends trigger/expire txs; neither needs
// the other's key, and the Vite app needs neither.
export const SECRET_KEYS = ['QUOTE_SIGNER_KEY', 'KEEPER_KEY'];

// argv (process.argv.slice(2)) -> options. Throws Error with a user-facing message on bad input.
export function parseDevArgs(argv, { defaultEnvPath } = {}) {
  const has = (f) => argv.includes(f);
  const val = (f, dflt) => {
    const i = argv.indexOf(f);
    if (i < 0) return dflt;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${f} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.includes(a)) i++;
    else if (!BOOL_FLAGS.includes(a)) throw new Error(`unknown argument ${a}`);
  }
  const keeperOnly = has('--keeper-only');
  const keeperDryRun = has('--keeper-dry-run');
  const engineOnly = has('--engine-only');
  const appOnly = has('--app-only');
  if (engineOnly && appOnly) throw new Error('--engine-only and --app-only exclude each other');
  if (keeperOnly && (engineOnly || appOnly)) throw new Error('--keeper-only excludes --engine-only and --app-only');
  const o = {
    envPath: val('--env', defaultEnvPath),
    enginePort: Number(val('--port', '8000')),
    appPort: Number(val('--app-port', '5173')),
    timeoutS: Number(val('--timeout', '90')),
    smoke: has('--smoke'),
    allowUnverifiedRpc: has('--allow-unverified-rpc'),
    // --keeper-dry-run alone implies --keeper (it is the dry-run variant of it).
    runKeeper: keeperOnly || has('--keeper') || keeperDryRun,
    keeperDryRun,
    runEngine: !keeperOnly && !appOnly,
    runApp: !keeperOnly && !engineOnly,
  };
  for (const [n, v] of [['--port', o.enginePort], ['--app-port', o.appPort]]) if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`${n} must be a TCP port number`);
  if (!(o.timeoutS > 0)) throw new Error('--timeout must be a positive number of seconds');
  return o;
}

export function withoutKeys(env, keys) {
  const out = { ...env };
  for (const k of keys) delete out[k];
  return out;
}

// Spawn description for the keeper child. `env` is the merged .env + shell environment; `rpcs` is the list of
// RPC URLs whose chain id dev.mjs verified (priority order). Returns { args, cwd, env, describe } (run with the engine venv python):
// `describe` is the one log line dev.mjs prints, and never contains the key or full RPC URLs.
export function keeperSpawn({ repoRoot, env, rpcs, dryRun, host = (u) => u }) {
  const key = (env.KEEPER_KEY ?? '').trim();
  if (!dryRun && !key) throw new Error('KEEPER_KEY is not set (looked in the .env file and the shell). The keeper cannot send trigger/expire txs without it. Use --keeper-dry-run for a read-only keeper.');
  const childEnv = withoutKeys(env, SECRET_KEYS.filter((k) => k !== 'KEEPER_KEY'));
  childEnv.PYTHONUNBUFFERED = '1';
  if (key) childEnv.KEEPER_KEY = key;
  else delete childEnv.KEEPER_KEY;
  if (rpcs.length) childEnv.NUMERA_RPCS = rpcs.join(',');
  const deployments = path.join(repoRoot, 'deployments', 'testnet.json');
  const args = ['-m', 'numera_engine.keeper', '--deployments', deployments];
  if (dryRun) args.push('--dry-run');
  const describe =
    `starting keeper${dryRun ? ' (dry run: read only, sends nothing)' : ''}` +
    ` (KEEPER_KEY ${key ? 'set' : 'not set'}, NUMERA_RPCS=${rpcs.length ? rpcs.map(host).join(' > ') : '(keeper default)'})`;
  return { args, cwd: path.join(repoRoot, 'engine'), env: childEnv, describe };
}

// The keeper logs `[keeper] poll ok ...` after every successful poll (engine/numera_engine/keeper.py).
export const KEEPER_READY_RE = /\[keeper\] poll ok\b/;
