// Reports the gzipped JavaScript that a page loads before any interaction: every <script src> plus the modules
// they import statically (transitively). Turnstile is not counted: it loads lazily near the form.
// Budget (build spec 2.11): target 60 KB, hard cap 200 KB, the premium grid included. Exit 1 over the cap.
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const page = process.argv[2] ?? 'index.html';
const html = readFileSync(path.join(DIST, page), 'utf8');
const seen = new Map();
const queue = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((m) => m[1]).filter((u) => u.startsWith('/'));
queue.push(...[...html.matchAll(/<link\b[^>]*rel=["']modulepreload["'][^>]*href=["']([^"']+)["']/gi)].map((m) => m[1]));
while (queue.length) {
  const u = queue.shift();
  if (seen.has(u)) continue;
  const f = path.join(DIST, u);
  if (!existsSync(f)) continue;
  const src = readFileSync(f);
  seen.set(u, { raw: src.length, gz: gzipSync(src, { level: 9 }).length });
  for (const m of src.toString('utf8').matchAll(/(?:import|from)\s*["'](\.{1,2}\/[^"']+\.js)["']/g))
    queue.push(path.posix.join(path.posix.dirname(u), m[1]));
}
let raw = 0;
let gz = 0;
for (const [u, s] of seen) {
  raw += s.raw;
  gz += s.gz;
  console.log(`${(s.gz / 1024).toFixed(1).padStart(7)} KB gz ${(s.raw / 1024).toFixed(1).padStart(7)} KB  ${u}`);
}
console.log(`${(gz / 1024).toFixed(1).padStart(7)} KB gz ${(raw / 1024).toFixed(1).padStart(7)} KB  total JS before interaction (${page}); target 60 KB, cap 200 KB`);
if (gz > 200 * 1024) process.exit(1);
