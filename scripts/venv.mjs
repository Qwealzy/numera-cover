#!/usr/bin/env node
// Resolves the engine virtualenv python. engine/.venv is gitignored, so worktrees (parallel workers)
// do not have one; fall back to the main checkout's venv.
// As a script: `node scripts/venv.mjs <python args...>` runs that python with the args (used by hooks).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rel = path.join('engine', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

export function venvPython(root) {
  const local = path.join(root, rel);
  if (existsSync(local)) return local;
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
  if (common.status === 0) {
    const main = path.join(path.dirname(common.stdout.trim()), rel);
    if (existsSync(main)) return main;
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const py = venvPython(root);
  if (!py) {
    console.error('engine venv not found. Create it: python -m venv engine/.venv (see docs/PLAN.md)');
    process.exit(1);
  }
  const r = spawnSync(py, process.argv.slice(2), { stdio: 'inherit', cwd: process.cwd() });
  process.exit(r.status ?? 1);
}
