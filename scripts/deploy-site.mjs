#!/usr/bin/env node
// Deploys the public early-access site (site/) to Cloudflare Pages. FOUNDER-RUN: needs `npx wrangler login`.
//
//   node scripts/deploy-site.mjs                  # preview: prints the plan, runs nothing
//   node scripts/deploy-site.mjs --yes            # preview deploy (branch "preview")
//   node scripts/deploy-site.mjs --prod --yes     # production deploy (branch "main" = numera-cover.pages.dev)
//   node scripts/deploy-site.mjs --help
//
// Steps: check the build env (the /privacy placeholders, Turnstile site key) and the D1 id; check the Pages
// secrets exist (names only, values are never read); production build; D1 migrations --remote; pages deploy.
// Values come from the shell environment only; this script reads no .env file and prints no secret.
// Every command runs with cwd site/ through its pinned local wrangler/astro (site/node_modules/.bin).
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { repoRoot } from './lib/tools.mjs';
import { USAGE, deployPlan, parseArgs } from './lib/deploysite.mjs';

const SITE = path.join(repoRoot, 'site');
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!existsSync(path.join(SITE, 'node_modules'))) {
  console.log('[FAIL] site/node_modules is missing: run npm ci in site/ first');
  process.exit(1);
}

const plan = deployPlan(args, process.env, readFileSync(path.join(SITE, 'wrangler.toml'), 'utf8'));
const shown = (s) => `${s.env ? 'SITE_ENV=production ' : ''}${s.cmd.join(' ')}`;
console.log(`[plan] Cloudflare Pages deploy of site/ (${args.prod ? 'PRODUCTION' : 'preview'}), cwd site/:`);
plan.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.name}: ${shown(s)}`));
if (plan.problems.length) {
  console.log('[FAIL] not ready:');
  for (const p of plan.problems) console.log(`  - ${p}`);
  process.exit(1);
}
if (!args.yes) {
  console.log('[plan] nothing run: re-run with --yes to execute');
  process.exit(0);
}

const bin = (name) => path.join(SITE, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
for (const [i, s] of plan.steps.entries()) {
  console.log(`\n[${i + 1}/${plan.steps.length}] ${s.name}`);
  const [cmd, ...rest] = s.cmd;
  const r = spawnSync(bin(cmd), rest, {
    cwd: SITE,
    env: { ...process.env, ...(s.env ?? {}) },
    stdio: s.expect ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32', // .cmd shims need a shell; every argument is a constant from the plan
    windowsHide: true,
  });
  if (r.status !== 0) {
    console.log(`[FAIL] ${s.name} (exit ${r.status})`);
    process.exit(1);
  }
  if (s.expect) {
    const missing = s.expect.filter((n) => !(r.stdout ?? '').includes(n));
    if (missing.length) {
      console.log(`[FAIL] Pages secrets missing: ${missing.join(', ')} (npx wrangler pages secret put <NAME> --project-name numera-cover)`);
      process.exit(1);
    }
    console.log(`[OK] secrets present: ${s.expect.join(', ')}`);
  }
}
console.log(`\n[OK] deployed branch ${plan.branch}; wrangler printed the URL above.`);
