// Shared helpers for scripts/*.mjs: repo root, main checkout, forge lookup, worktree listing.
// Node only, no dependencies. Every external command is spawned with explicit args (no shell chaining),
// so the scripts behave the same in Windows PowerShell 5.1, pwsh, cmd and Git Bash.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// foundryup installs to ~/.foundry/bin, which is not on PATH on this machine.
export function forgePath() {
  const bin = path.join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'forge.exe' : 'forge');
  return existsSync(bin) ? bin : 'forge';
}

export function git(args, cwd = repoRoot) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

// The main checkout (worktrees share its .git). Gitignored things (engine/.venv, .env, node_modules) live there.
export function mainCheckout(root = repoRoot) {
  const r = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  return r.ok ? path.dirname(r.out) : root;
}

// `git worktree list --porcelain` -> [{ path, head, branch }]
export function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9).trim(), head: '', branch: '' };
      out.push(cur);
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
  }
  return out;
}

// Spawn options for a child that runs a shell-less command on every platform. npm is a .cmd on Windows and
// Node refuses to spawn .cmd files without a shell, so npm alone needs shell:true (args are constants).
export function npmSpawn() {
  return process.platform === 'win32' ? { cmd: 'npm', shell: true } : { cmd: 'npm', shell: false };
}
