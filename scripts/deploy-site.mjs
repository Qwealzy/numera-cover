#!/usr/bin/env node
// Deploys the public early-access site (waitlist/) to Cloudflare Pages. FOUNDER-RUN: needs `npx wrangler login`.
// site/ stays in the repo and in check.mjs but is not deployed (founder decision 2026-10-03, option b).
//
//   node scripts/deploy-site.mjs                  # preview: prints the plan, runs nothing
//   node scripts/deploy-site.mjs --yes            # preview deploy (branch "preview")
//   node scripts/deploy-site.mjs --prod --yes     # production deploy (branch "main" = numera-cover.pages.dev)
//   node scripts/deploy-site.mjs --create-project --yes  # first run only: create the Pages project (nothing else)
//   node scripts/deploy-site.mjs --create-db --yes  # first run only: create the D1 database in the eu jurisdiction (nothing else)
//   node scripts/deploy-site.mjs --help
//
// Steps: check the D1 database is in the eu jurisdiction (wrangler d1 list --json, matched by wrangler.toml's database_id; refuses otherwise); check the build env (the /privacy and /terms placeholders, the Source link, Turnstile site key) and the D1 id; check the Pages
// secrets exist (names only, values are never read); production build; D1 migrations 0001+0002 --remote; pages deploy.
// Values come from the shell environment only; this script reads no .env file and prints no secret.
// Every command runs with cwd waitlist/ through its pinned local wrangler/astro (waitlist/node_modules/.bin).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { repoRoot } from './lib/tools.mjs';
import { USAGE, SITE_DIR, deployPlan, parseArgs, judgeJurisdiction } from './lib/deploysite.mjs';

const SITE = path.join(repoRoot, SITE_DIR);
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!existsSync(path.join(SITE, 'node_modules'))) {
  console.log(`[FAIL] ${SITE_DIR}/node_modules is missing: run npm ci in ${SITE_DIR}/ first`);
  process.exit(1);
}

// the private origin remote, so the footer Source link can be refused if it points there (read-only git call)
const originUrl = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).stdout?.trim() ?? '';
const plan = deployPlan(
  args,
  process.env,
  readFileSync(path.join(SITE, 'wrangler.toml'), 'utf8'),
  readdirSync(path.join(SITE, 'migrations')),
  originUrl,
);
const shown = (s) => `${s.env ? 'SITE_ENV=production ' : ''}${s.cmd.join(' ')}`;
console.log(`[plan] Cloudflare Pages ${plan.setupOnly ? 'setup' : `deploy of ${SITE_DIR}/ (${args.prod ? 'PRODUCTION' : 'preview'})`}, cwd ${SITE_DIR}/:`);
plan.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.name}: ${shown(s)}`));
if (plan.setupOnly) console.log('[plan] setup flags only create the resource(s) named above (no env, secret or database checks); then run again without them');
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
    stdio: s.expect || s.jurisdiction ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32', // .cmd shims need a shell; every argument is a constant from the plan
    windowsHide: true,
  });
  if (r.status !== 0) {
    console.log(`[FAIL] ${s.name} (exit ${r.status})`);
    process.exit(1);
  }
  if (s.jurisdiction) {
    const j = judgeJurisdiction(r.stdout, s.jurisdiction.databaseId);
    if (j.verdict === 'ok') console.log(`[OK] ${j.message}`);
    else if (j.verdict === 'refuse' || !s.jurisdiction.acceptUnverified) {
      console.log(`[FAIL] ${j.message}`);
      process.exit(1);
    } else {
      console.log(`[WARN] ${j.message}`);
      console.log('[WARN] continuing because --accept-unverified-jurisdiction was given');
    }
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
console.log('');
console.log(plan.setupOnly ? '[OK] created. A new D1 database: paste the database_id wrangler printed into waitlist/wrangler.toml. A new Pages project: set its secrets, then run again without the setup flags.' : `[OK] deployed branch ${plan.branch}; wrangler printed the URL above.`);
