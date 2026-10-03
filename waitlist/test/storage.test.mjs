// node --test: the page stores nothing in the browser, and motion follows only the OS reduced-motion setting
// (plus the hero's pause button for the page view). There is no site-wide motion switch to remember.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE = /localStorage|sessionStorage|indexedDB|document\.cookie|numera-motion/;

function files(dir, ext) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p, ext));
    else if (ext.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

test('no browser storage in the sources (client code, components, boot.js)', () => {
  for (const f of [...files(path.join(SITE, 'src'), ['.ts', '.astro', '.mjs']), ...files(path.join(SITE, 'public'), ['.js'])])
    assert.doesNotMatch(readFileSync(f, 'utf8'), STORAGE, path.relative(SITE, f));
});

test('no browser storage in the built scripts', () => {
  for (const f of files(path.join(SITE, 'dist'), ['.js'])) assert.doesNotMatch(readFileSync(f, 'utf8'), STORAGE, path.relative(SITE, f));
});

test('boot.js: motion is on unless the OS asks for reduced motion', () => {
  const t = readFileSync(path.join(SITE, 'public/boot.js'), 'utf8');
  assert.match(t, /prefers-reduced-motion: reduce/);
  assert.match(t, /setAttribute\('data-motion', reduce \? 'off' : 'on'\)/);
});

test('the nav has no motion switch', () => {
  const t = readFileSync(path.join(SITE, 'src/components/Header.astro'), 'utf8');
  assert.doesNotMatch(t, /data-motion-toggle|aria-pressed/);
  assert.doesNotMatch(readFileSync(path.join(SITE, 'src/client/nav.ts'), 'utf8'), /setMotion/);
});
