// Tests for the site deploy plan: node --test scripts/lib/deploysite.test.mjs (run by scripts/check.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deployPlan, parseArgs, d1DatabaseId, PLACEHOLDER_DB_ID } from './deploysite.mjs';

const TOML = (id) => `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "numera-waitlist"\ndatabase_id = "${id}"\n`;
const ENV = { SITE_CONTROLLER_NAME: 'Example', SITE_DELETE_BY: '2027-03-31', PUBLIC_TURNSTILE_SITEKEY: '0x4AAAAAAA' };

test('committed wrangler.toml still carries the placeholder id (deploy refuses until the founder sets it)', () => {
  const toml = readFileSync(new URL('../../site/wrangler.toml', import.meta.url), 'utf8');
  assert.equal(d1DatabaseId(toml), PLACEHOLDER_DB_ID);
  assert.match(deployPlan(parseArgs([]), ENV, toml).problems.join('\n'), /database_id is the placeholder/);
});

test('ready env: preview by default, --prod deploys branch main; order build -> migrate -> deploy', () => {
  const ok = deployPlan(parseArgs([]), ENV, TOML('abc-123'));
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.branch, 'preview');
  assert.deepEqual(ok.steps.map((s) => s.cmd[0] + ' ' + s.cmd[1]), ['wrangler pages', 'astro build', 'wrangler d1', 'wrangler pages']);
  assert.deepEqual(ok.steps.at(-1).cmd.slice(-4), ['--project-name', 'numera-cover', '--branch', 'preview']);
  assert.ok(ok.steps[2].cmd.includes('--remote'));
  assert.equal(ok.steps[1].env.SITE_ENV, 'production');
  const prod = deployPlan(parseArgs(['--prod', '--create-project']), ENV, TOML('abc-123'));
  assert.equal(prod.branch, 'main');
  assert.equal(prod.steps[0].name, 'create Pages project');
});

test('missing env values and unknown flags are problems; nothing is a mainnet or chain step', () => {
  const p = deployPlan(parseArgs(['--force']), {}, TOML('abc-123'));
  const text = p.problems.join('\n');
  for (const re of [/SITE_CONTROLLER_NAME/, /SITE_DELETE_BY/, /PUBLIC_TURNSTILE_SITEKEY/, /unknown argument\(s\): --force/]) assert.match(text, re);
  assert.match(deployPlan(parseArgs([]), { ...ENV, PUBLIC_TURNSTILE_SITEKEY: '1x00000000000000000000AA' }, TOML('a')).problems.join(), /test key/);
});
