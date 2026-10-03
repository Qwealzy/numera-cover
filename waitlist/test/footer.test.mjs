// node --test: the footer's contact links are icon-only links to exactly the two public accounts, with an
// accessible name, a new tab without opener or referrer, a 44 px tap target and a visible focus ring. The icons
// are inline SVG (no external request). The built page is checked when a build exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { footer } from '../src/copy/en.ts';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const astro = readFileSync(path.join(SITE, 'src/components/Footer.astro'), 'utf8');

test('copy: exactly the two accounts, with their accessible names', () => {
  assert.equal(footer.telegram.href, 'https://t.me/godsonits');
  assert.equal(footer.x.href, 'https://x.com/ggodsonits');
  assert.equal(footer.telegram.aria, 'Numera on Telegram');
  assert.equal(footer.x.aria, 'Numera on X');
});

test('markup: icon-only links (inline SVG), aria-label, target _blank, rel noopener noreferrer, 44 px, focus ring', () => {
  assert.match(astro, /<a class="icon-link" href=\{o\.href\} target="_blank" rel="noopener noreferrer" aria-label=\{o\.aria\}>\s*<svg [^>]*aria-hidden="true" focusable="false"><path d=\{o\.path\} fill-rule="evenodd" \/><\/svg>\s*<\/a>/);
  assert.doesNotMatch(astro, /\{F\.(telegram|x)\.handle\}/, 'no visible handle text in the footer');
  assert.match(astro, /\.foot-links \.icon-link \{[^}]*width: 44px;[^}]*height: 44px;/);
  assert.match(astro, /\.icon-link:focus-visible \{\s*outline: var\(--focus\);/);
});

test('built pages: the footer links to exactly the two accounts, icon-only', () => {
  for (const page of ['index.html', 'privacy.html', 'terms.html', '404.html']) {
    const f = path.join(SITE, 'dist', page);
    if (!existsSync(f)) continue;
    const foot = readFileSync(f, 'utf8').match(/<footer[\s\S]*<\/footer>/)?.[0] ?? '';
    const ext = [...foot.matchAll(/href="(https?:[^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ext, ['https://t.me/godsonits', 'https://x.com/ggodsonits'], page);
    assert.match(foot, /href="\/privacy"/);
    assert.match(foot, /href="\/terms"/);
    assert.match(foot, /aria-label="Numera on Telegram"/);
    assert.match(foot, /aria-label="Numera on X"/);
    assert.doesNotMatch(foot.replace(/<[^>]+>/g, ' '), /@g?godsonits/, `${page}: no visible handle text`);
  }
});
