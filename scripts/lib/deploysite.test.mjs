// Tests for the site deploy plan: node --test scripts/lib/deploysite.test.mjs (run by scripts/check.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { deployPlan, parseArgs, repoKey, judgeJurisdiction, D1_JURISDICTION, d1DatabaseId, PLACEHOLDER_DB_ID, SITE_DIR, MIGRATIONS, USAGE } from './deploysite.mjs';

const TOML = (id) =>
  `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "numera-waitlist"\ndatabase_id = "${id}"\nmigrations_dir = "migrations"\n`;
const ENV = { SITE_CONTROLLER_NAME: 'Example', SITE_DELETE_BY: '2027-03-31', SITE_GOVERNING_LAW: 'Example Land', SITE_SOURCE_URL: 'https://github.com/example/numera-public', PUBLIC_TURNSTILE_SITEKEY: '0x4AAAAAAA' };

test('deploys waitlist/ with its migrations 0001 + 0002; the committed files are all there', () => {
  assert.equal(SITE_DIR, 'waitlist');
  assert.deepEqual(MIGRATIONS, ['0001_waitlist.sql', '0002_email.sql']);
  const files = readdirSync(new URL('../../waitlist/migrations/', import.meta.url));
  for (const m of MIGRATIONS) assert.ok(files.includes(m), m);
  assert.match(USAGE, /Builds and deploys waitlist\/ and applies its D1 migrations \(0001_waitlist\.sql, 0002_email\.sql\)/);
  // a migration missing from the folder is a problem, not a silent skip
  assert.match(deployPlan(parseArgs([]), ENV, TOML('abc-123'), ['0001_waitlist.sql']).problems.join('\n'), /waitlist\/migrations\/0002_email\.sql is missing/);
  assert.match(deployPlan(parseArgs([]), ENV, TOML('abc-123').replace(/migrations_dir.*\n/, '')).problems.join('\n'), /no migrations_dir/);
});

test('committed wrangler.toml still carries the placeholder id (deploy refuses until the founder sets it)', () => {
  const toml = readFileSync(new URL('../../waitlist/wrangler.toml', import.meta.url), 'utf8');
  assert.equal(d1DatabaseId(toml), PLACEHOLDER_DB_ID);
  assert.match(deployPlan(parseArgs([]), ENV, toml).problems.join('\n'), /database_id is the placeholder/);
});

test('ready env: preview by default, --prod deploys branch main; order secrets -> D1 jurisdiction -> build -> migrate -> deploy', () => {
  const ok = deployPlan(parseArgs([]), ENV, TOML('abc-123'));
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.branch, 'preview');
  assert.deepEqual(ok.steps.map((s) => s.cmd[0] + ' ' + s.cmd[1]), ['wrangler pages', 'wrangler d1', 'astro build', 'wrangler d1', 'wrangler pages']);
  assert.deepEqual(ok.steps.at(-1).cmd.slice(-4), ['--project-name', 'numera-cover', '--branch', 'preview']);
  assert.ok(ok.steps[3].cmd.includes('--remote'));
  assert.equal(ok.steps[3].name, 'apply D1 migrations 0001+0002 (remote)');
  assert.equal(ok.steps[2].env.SITE_ENV, 'production');
  assert.equal(ok.steps[2].env.SITE_GOVERNING_LAW, 'Example Land'); // fills {{GOVERNING_LAW}} on /terms
  assert.equal(ok.steps[2].env.SITE_SOURCE_URL, 'https://github.com/example/numera-public'); // the footer Source link
  const prod = deployPlan(parseArgs(['--prod', '--create-project']), ENV, TOML('abc-123'));
  assert.equal(prod.branch, 'main');
  assert.equal(prod.steps[0].name, 'create Pages project');
});

test('missing env values and unknown flags are problems; nothing is a mainnet or chain step', () => {
  const p = deployPlan(parseArgs(['--force']), {}, TOML('abc-123'));
  const text = p.problems.join('\n');
  for (const re of [/SITE_CONTROLLER_NAME/, /SITE_DELETE_BY/, /SITE_GOVERNING_LAW/, /SITE_SOURCE_URL/, /PUBLIC_TURNSTILE_SITEKEY/, /unknown argument\(s\): --force/]) assert.match(text, re);
  assert.match(deployPlan(parseArgs([]), { ...ENV, PUBLIC_TURNSTILE_SITEKEY: '1x00000000000000000000AA' }, TOML('a')).problems.join(), /test key/);
});

test('the footer Source link may not be the private origin repository, in any spelling of its URL', () => {
  const origin = 'https://github.com/Example-Owner/private-repo.git';
  for (const same of ['https://github.com/example-owner/private-repo', 'https://github.com/Example-Owner/private-repo.git/', 'git@github.com:Example-Owner/private-repo.git'])
    assert.equal(repoKey(same), repoKey(origin), same);
  const bad = deployPlan(parseArgs([]), { ...ENV, SITE_SOURCE_URL: 'https://github.com/example-owner/private-repo' }, TOML('abc-123'), undefined, origin);
  assert.match(bad.problems.join(' | '), /SITE_SOURCE_URL is the private origin repository/);
  assert.deepEqual(deployPlan(parseArgs([]), ENV, TOML('abc-123'), undefined, origin).problems, []);
  // not an https URL at all
  assert.match(deployPlan(parseArgs([]), { ...ENV, SITE_SOURCE_URL: 'git@github.com:a/b.git' }, TOML('abc-123')).problems.join(), /SITE_SOURCE_URL must be an https URL/);
});

test('D1 jurisdiction: the database must be in eu; the check runs before the build and the migrations', () => {
  assert.equal(D1_JURISDICTION, 'eu');
  const plan = deployPlan(parseArgs([]), ENV, TOML('abc-123'));
  const names = plan.steps.map((x) => x.name);
  const at = names.findIndex((n) => /eu jurisdiction/.test(n));
  assert.ok(at > 0 && at < names.findIndex((n) => /^build/.test(n)) && at < names.findIndex((n) => /migrations/.test(n)));
  assert.deepEqual(plan.steps[at].cmd, ['wrangler', 'd1', 'info', 'numera-waitlist', '--json']);
  assert.deepEqual(plan.steps[at].jurisdiction, { acceptUnverified: false });
  assert.deepEqual(deployPlan(parseArgs(['--accept-unverified-jurisdiction']), ENV, TOML('abc-123')).steps[at].jurisdiction, { acceptUnverified: true });
});

test('judgeJurisdiction: eu passes, any other reported jurisdiction is refused, unreported or unreadable output is unknown', () => {
  assert.equal(judgeJurisdiction('{"uuid":"x","name":"numera-waitlist","jurisdiction":"eu"}').verdict, 'ok');
  assert.equal(judgeJurisdiction('banner line\n{"name":"n","jurisdiction":"EU"}\n').verdict, 'ok');
  assert.equal(judgeJurisdiction('{"result":{"jurisdiction":"eu"}}').verdict, 'ok');
  for (const j of ['us', 'fedramp']) {
    const r = judgeJurisdiction(JSON.stringify({ name: 'numera-waitlist', jurisdiction: j }));
    assert.equal(r.verdict, 'refuse', j);
    assert.match(r.message, /cannot be changed/);
    assert.match(r.message, /--jurisdiction eu/);
  }
  for (const out of ['{"name":"numera-waitlist","num_tables":2}', '{"jurisdiction":null}', '{"jurisdiction":""}', 'not json', '', undefined]) {
    const r = judgeJurisdiction(out);
    assert.equal(r.verdict, 'unknown', String(out));
    assert.match(r.message, /^WARNING: wrangler did not report the jurisdiction/);
    assert.match(r.message, /--accept-unverified-jurisdiction/);
  }
});

test('--create-db creates the database with --jurisdiction eu and nothing else; the placeholder problem names it', () => {
  const p = deployPlan(parseArgs(['--create-db']), {}, TOML('00000000-0000-0000-0000-000000000000'));
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.steps.map((x) => x.cmd), [['wrangler', 'd1', 'create', 'numera-waitlist', '--jurisdiction', 'eu']]);
  assert.equal(p.branch, null);
  assert.match(deployPlan(parseArgs([]), ENV, TOML('00000000-0000-0000-0000-000000000000')).problems.join(' | '), /--create-db --yes \(wrangler d1 create numera-waitlist --jurisdiction eu\)/);
  assert.match(USAGE, /--create-db[\s\S]*--jurisdiction eu/);
  assert.match(USAGE, /--accept-unverified-jurisdiction/);
  assert.match(deployPlan(parseArgs(['--create-db', '--force']), {}, TOML('abc')).problems.join(), /unknown argument\(s\): --force/);
  // no other step anywhere creates a database or touches it without the jurisdiction guard
  for (const x of deployPlan(parseArgs(['--prod', '--create-project']), ENV, TOML('abc-123')).steps) assert.ok(!(x.cmd[1] === 'd1' && x.cmd[2] === 'create'));
});
