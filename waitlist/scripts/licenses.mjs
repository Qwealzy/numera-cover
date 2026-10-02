// License report: every direct dependency with the license field npm reports, then a transitive summary
// (counts per license) read from node_modules/**/package.json, naming every package outside the allowlist.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(SITE, 'node_modules');
const OK = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'OFL-1.1', 'BlueOak-1.0.0', 'Unlicense', 'CC0-1.0']);
const allowed = (l) =>
  l
    .replace(/[()]/g, '')
    .split(/ OR /)
    .some((alt) => alt.split(/ AND /).every((x) => OK.has(x.trim())));
const lic = (pj) =>
  typeof pj.license === 'string'
    ? pj.license
    : (pj.license?.type ?? (Array.isArray(pj.licenses) ? pj.licenses.map((l) => l.type).join(' OR ') : 'UNKNOWN'));
const pkg = JSON.parse(readFileSync(path.join(SITE, 'package.json'), 'utf8'));

console.log('Direct dependencies');
for (const [kind, deps] of [
  ['dependencies', pkg.dependencies],
  ['devDependencies', pkg.devDependencies],
])
  for (const name of Object.keys(deps ?? {})) {
    const pj = JSON.parse(readFileSync(path.join(NM, name, 'package.json'), 'utf8'));
    console.log(`  ${name}@${pj.version}  ${lic(pj)}  (${kind})`);
  }

const all = new Map();
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    if (n.startsWith('.')) continue;
    const p = path.join(dir, n);
    if (!statSync(p).isDirectory()) continue;
    if (n.startsWith('@')) {
      walk(p);
      continue;
    }
    const pjf = path.join(p, 'package.json');
    if (existsSync(pjf)) {
      try {
        const pj = JSON.parse(readFileSync(pjf, 'utf8'));
        if (pj.name && pj.version) all.set(`${pj.name}@${pj.version}`, lic(pj));
      } catch {
        // not a package manifest
      }
    }
    walk(path.join(p, 'node_modules'));
  }
}
walk(NM);
const counts = {};
const outside = [];
for (const [id, l] of all) {
  counts[l] = (counts[l] ?? 0) + 1;
  if (!allowed(l)) outside.push(`${id}  ${l}`);
}
console.log(`\nTransitive packages: ${all.size}`);
for (const [l, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${l}`);
console.log(`\nOutside the allowlist (MIT, ISC, Apache-2.0, BSD-2/3-Clause, 0BSD, OFL-1.1, BlueOak-1.0.0, Unlicense, CC0-1.0): ${outside.length}`);
for (const o of outside.sort()) console.log(`  ${o}`);
