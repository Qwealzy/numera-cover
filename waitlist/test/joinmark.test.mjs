// node --test: the 3D mark behind the join section stays out of the first load. three.js is imported only by
// src/client/mark3d.ts, which only the lazy loader imports, dynamically. With a build: no script the home page
// loads up front contains three.js, and the CSP still names no new origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(SITE, p), 'utf8');

test('only mark3d.ts imports three, and only joinmark.ts loads mark3d.ts (dynamically)', () => {
  for (const f of readdirSync(path.join(SITE, 'src/client'))) {
    const t = read(`src/client/${f}`);
    if (f !== 'mark3d.ts') assert.doesNotMatch(t, /from ['"]three/, f);
    if (f !== 'joinmark.ts') assert.doesNotMatch(t, /mark3d/, f);
  }
  const loader = read('src/client/joinmark.ts');
  assert.match(loader, /import\('\.\/mark3d\.ts'\)/);
  assert.doesNotMatch(loader, /^import .*mark3d/m);
  assert.match(loader, /rootMargin: JOIN_MARK_ROOT_MARGIN/);
  assert.match(loader, /motionOn\(\) \|\| !webglOk\(\)/, 'reduced motion and no WebGL keep the flat mark');
});

test('the 3D mark caps the pixel ratio at 2 and renders through the shared scheduler', () => {
  const t = read('src/client/mark3d.ts');
  assert.match(t, /MARK_MAX_DPR = 2;/);
  assert.match(t, /setPixelRatio\(Math\.min\(window\.devicePixelRatio \|\| 1, MARK_MAX_DPR\)\)/);
  assert.match(t, /loop\('join-mark', box,/);
});

test('CSP: no new origin; scripts from self and Turnstile only', () => {
  const h = read('public/_headers');
  assert.match(h, /script-src 'self' https:\/\/challenges\.cloudflare\.com;/);
  assert.match(h, /connect-src 'self' https:\/\/rpcs\.chain\.link https:\/\/rpc\.hyperliquid-testnet\.xyz;/);
});

test('built home page: three.js is not in any script loaded up front', () => {
  const f = path.join(SITE, 'dist', 'index.html');
  if (!existsSync(f)) return;
  const html = readFileSync(f, 'utf8');
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length > 0);
  for (const s of srcs) {
    const js = readFileSync(path.join(SITE, 'dist', s), 'utf8');
    assert.doesNotMatch(js, /Three\.js Authors|WebGLRenderer/, s);
  }
  assert.ok(readdirSync(path.join(SITE, 'dist', '_astro')).some((n) => /^mark3d\..*\.js$/.test(n)), 'the lazy chunk exists');
});
