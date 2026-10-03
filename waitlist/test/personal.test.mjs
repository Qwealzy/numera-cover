// node --test: the project's personal-data patterns find nothing in src/, public/ or dist/.
// The pattern list belongs to the project's export tooling and is imported at test time, never copied here. A
// checkout that does not contain that tooling (the published repository) skips this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(SITE, '..');

async function loadPersonal() {
  const roots = [REPO];
  try {
    const common = execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    roots.push(path.dirname(common)); // the main checkout that owns this worktree
  } catch {
    // not a git checkout
  }
  for (const r of roots) {
    const f = path.join(r, 'scripts', 'lib', 'exportscrub.mjs');
    if (existsSync(f)) return { from: f, list: (await import(pathToFileURL(f).href)).PERSONAL };
  }
  return null; // no export tooling in this checkout
}

function files(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(astro|ts|mjs|js|css|html|json|svg|txt|md|sql)$/.test(n) || n === '_headers') out.push(p);
  }
  return out;
}

test('personal-data patterns of the public export find nothing in src, public and dist', async (t) => {
  const found = await loadPersonal();
  if (!found) return t.skip('the export tooling that defines the pattern list is not part of this checkout');
  const { from, list } = found;
  assert.ok(list.length >= 6, `expected the PERSONAL list from ${from}`);
  const hits = [];
  for (const f of [...files(path.join(SITE, 'src')), ...files(path.join(SITE, 'public')), ...files(path.join(SITE, 'dist'))]) {
    readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const p of list) {
          if (!p.re.test(line)) continue;
          if (p.allow && !p.re.test(line.replace(new RegExp(p.allow.source, 'gi'), ''))) continue;
          hits.push(`${path.relative(SITE, f)}:${i + 1} (${p.name})`);
        }
      });
  }
  assert.deepEqual(hits, []);
});
