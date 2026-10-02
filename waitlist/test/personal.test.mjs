// node --test: the repo's public-export personal-data patterns find nothing in src/, public/ or dist/.
// The patterns are imported at test time, never copied here: scripts/lib/exportscrub.mjs (PERSONAL) in this
// checkout or the main checkout of the same repository; on older commits they are read from
// scripts/export-public.mjs, which defines the same list.
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
  // fallback: the same list inside scripts/export-public.mjs (not importable: it runs on import)
  const f = path.join(REPO, 'scripts', 'export-public.mjs');
  const src = readFileSync(f, 'utf8');
  const block = src.slice(src.indexOf('const PERSONAL = ['), src.indexOf('];', src.indexOf('const PERSONAL = [')));
  const lit = (s) => {
    const m = s.match(/^\/(.+)\/([a-z]*)$/);
    return new RegExp(m[1], m[2]);
  };
  const list = [...block.matchAll(/name: '([^']+)',\s*re: (\/.+?\/[a-z]*)(?:,\s*allow: (\/.+?\/[a-z]*))?,?\s*\}/gs)].map((m) => ({
    name: m[1],
    re: lit(m[2]),
    allow: m[3] ? lit(m[3]) : undefined,
  }));
  return { from: f, list };
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

test('personal-data patterns of the public export find nothing in src, public and dist', async () => {
  const { from, list } = await loadPersonal();
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
