#!/usr/bin/env node
// Deploys the trader app (app/) to its own Cloudflare Pages project. FOUNDER-RUN: needs `npx wrangler login`.
//
//   node scripts/deploy-app.mjs                  # plan only: prints it, runs nothing
//   node scripts/deploy-app.mjs --yes            # preview deploy (branch "preview")
//   node scripts/deploy-app.mjs --prod --yes     # production deploy (branch "main"; the custom domain is attached in the dashboard)
//   node scripts/deploy-app.mjs --create-project --yes   # first run only: create the Pages project (nothing else)
//   node scripts/deploy-app.mjs --help
//
// Build env comes from the shell only (VITE_ENGINE_URL, default https://api.numeralabs.xyz); no .env file is read, no secret printed.
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { repoRoot } from './lib/tools.mjs';
import { USAGE, APP_DIR, deployPlan, parseArgs } from './lib/deployapp.mjs';

const APP = path.join(repoRoot, APP_DIR);
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
const envFiles = existsSync(APP) ? readdirSync(APP).filter((f) => f.startsWith('.env') && f !== '.env.example') : [];
const plan = deployPlan(args, process.env, envFiles);
const shown = (s) => `${s.env ? Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join(' ') + ' ' : ''}${s.cmd.join(' ')}`;
console.log(`[plan] Cloudflare Pages ${plan.setupOnly ? 'setup' : `deploy of ${APP_DIR}/ (${args.prod ? 'PRODUCTION' : 'preview'})`}, cwd ${APP_DIR}/:`);
plan.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.name}: ${shown(s)}`));
for (const w of plan.warnings) console.log(`[WARN] ${w}`);
if (plan.problems.length) {
  console.log('[FAIL] not ready:');
  for (const p of plan.problems) console.log(`  - ${p}`);
  process.exit(1);
}
if (!args.yes) {
  console.log('[plan] nothing run: re-run with --yes to execute');
  process.exit(0);
}
if (!plan.setupOnly && !existsSync(path.join(APP, 'node_modules'))) {
  console.log(`[FAIL] ${APP_DIR}/node_modules is missing: run npm ci in ${APP_DIR}/ first`);
  process.exit(1);
}
for (const [i, s] of plan.steps.entries()) {
  console.log(`\n[${i + 1}/${plan.steps.length}] ${s.name}`);
  const [cmd, ...rest] = s.cmd;
  const r = spawnSync(cmd, rest, {
    cwd: APP,
    env: { ...process.env, ...(s.env ?? {}) },
    stdio: 'inherit',
    shell: process.platform === 'win32', // npm/npx are .cmd shims; every argument is a constant from the plan
    windowsHide: true,
  });
  if (r.status !== 0) {
    console.log(`[FAIL] ${s.name} (exit ${r.status})`);
    process.exit(1);
  }
}
console.log('');
console.log(plan.setupOnly ? '[OK] project created. Next: node scripts/deploy-app.mjs --prod --yes, then attach the custom domain in the dashboard (Pages > numera-app > Custom domains).' : `[OK] deployed branch ${plan.branch}; wrangler printed the URL above.`);
