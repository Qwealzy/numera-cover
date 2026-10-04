// Tests for the app deploy plan: node --test scripts/lib/deployapp.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { deployPlan, parseArgs, engineUrl, DEFAULT_ENGINE_URL, PROJECT, APP_DIR, USAGE } from './deployapp.mjs';

test('default: preview branch, builds with the engine URL for all three names, then deploys dist', () => {
  const p = deployPlan(parseArgs([]), {});
  assert.deepEqual(p.problems, []);
  assert.equal(p.branch, 'preview');
  assert.equal(PROJECT, 'numera-app');
  assert.equal(DEFAULT_ENGINE_URL, 'https://api.numeralabs.xyz');
  const [build, deploy] = p.steps;
  assert.equal(build.env.VITE_ENGINE_URL, 'https://api.numeralabs.xyz');
  assert.equal(build.env.VITE_ENGINE_URL_MOCK, 'https://api.numeralabs.xyz');
  assert.equal(build.env.VITE_ENGINE_URL_HYPERCORE, 'https://api.numeralabs.xyz');
  assert.equal(build.env.VITE_USE_QUOTE_FIXTURE, '0');
  assert.ok(deploy.cmd.join(' ').includes('pages deploy dist --project-name numera-app --branch preview'));
});

test('--prod deploys branch main', () => {
  const p = deployPlan(parseArgs(['--prod']), {});
  assert.equal(p.branch, 'main');
  assert.ok(p.steps[1].cmd.join(' ').endsWith('--branch main'));
});

test('--create-project only creates the project (production branch main)', () => {
  const p = deployPlan(parseArgs(['--create-project']), { VITE_ENGINE_URL: 'http://localhost:8000' });
  assert.equal(p.setupOnly, true);
  assert.equal(p.steps.length, 1);
  assert.ok(p.steps[0].cmd.join(' ').includes('pages project create numera-app --production-branch main'));
  assert.deepEqual(p.problems, []);
});

test('engine URL: public https origin only', () => {
  assert.equal(engineUrl('https://api.numeralabs.xyz/').url, 'https://api.numeralabs.xyz');
  assert.equal(engineUrl('').url, DEFAULT_ENGINE_URL);
  for (const bad of ['http://api.numeralabs.xyz', 'https://localhost:8000', 'http://127.0.0.1:8000', 'https://x.test', 'https://a.example/engine', 'https://u:p@a.example', 'not a url', '/engine'])
    assert.ok(engineUrl(bad).problem, bad);
});

test('refuses fixture mode, an http RPC and unknown flags; warns about app/.env files', () => {
  assert.match(deployPlan(parseArgs([]), { VITE_USE_QUOTE_FIXTURE: '1' }).problems.join(), /FIXTURE/);
  assert.match(deployPlan(parseArgs([]), { VITE_RPC_URL: 'http://localhost:8545' }).problems.join(), /VITE_RPC_URL/);
  assert.match(deployPlan(parseArgs(['--nope']), {}).problems.join(), /unknown argument/);
  assert.match(deployPlan(parseArgs([]), {}, ['.env.local']).warnings.join(), /\.env\.local/);
  assert.match(USAGE, /--yes/);
});

test('the app ships the noindex header, meta tag and robots.txt, and nothing public links it (D31)', () => {
  const root = new URL('../../', import.meta.url);
  const headers = readFileSync(new URL(`${APP_DIR}/public/_headers`, root), 'utf8');
  assert.match(headers, /X-Robots-Tag:\s*noindex,\s*nofollow/i);
  assert.match(readFileSync(new URL(`${APP_DIR}/index.html`, root), 'utf8'), /name="robots" content="noindex, nofollow"/);
  assert.match(readFileSync(new URL(`${APP_DIR}/public/robots.txt`, root), 'utf8'), /Disallow:\s*\//);
  const readme = readFileSync(new URL('README.md', root), 'utf8');
  assert.ok(!/app\.numeralabs\.xyz/i.test(readme), 'README must not link the unlisted app');
  assert.ok(existsSync(new URL('deploy/vps/README.md', root)));
});
