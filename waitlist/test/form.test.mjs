// node --test: the compact join form. Email and submit share a row; the Telegram/X block is collapsed behind a
// real disclosure button; helper texts show only on focus; every input keeps a label; both checkboxes stay;
// Turnstile renders interaction-only (the server-side check is unchanged and tested in waitlist.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const astro = readFileSync(path.join(SITE, 'src/components/Waitlist.astro'), 'utf8');
const client = readFileSync(path.join(SITE, 'src/client/join.ts'), 'utf8');

test('email and submit on one row; the handle block behind <button aria-expanded> and hidden by default', () => {
  assert.match(astro, /<div class="email-row">[\s\S]*id="wl-email"[\s\S]*data-submit[\s\S]*<\/div>\s*<p id="wl-email-hint"/);
  assert.match(astro, /<button type="button" class="more-toggle" aria-expanded="false" aria-controls="wl-more"/);
  assert.match(astro, /<div id="wl-more" class="more-body" data-more-body hidden>[\s\S]*\(\['telegram', 'x'\] as const\)\.map/);
  // two optional inputs with their own icon; no channel toggle any more
  assert.match(astro, /id=\{`wl-\$\{k\}`\}/);
  assert.match(astro, /<svg class="in-icon" viewBox=\{ICON_VIEWBOX\} aria-hidden="true" focusable="false"><path d=\{k === 'telegram' \? TELEGRAM_PATH : X_PATH\} fill-rule="evenodd" \/><\/svg>/);
  assert.doesNotMatch(astro, /name="channel"|wl-handle"/);
  assert.match(client, /moreToggle\.setAttribute\('aria-expanded', String\(open\)\)/);
});

test('every input has a label; helper texts are focus-only; the stored-as line and the door toggle are gone', () => {
  for (const id of ['wl-email', 'wl-jurisdiction', 'wl-consent']) assert.match(astro, new RegExp(`<label for="${id}"`));
  assert.match(astro, /<label for=\{`wl-\$\{k\}`\} class="visually-hidden">\{Wl\[k\]\.label\}<\/label>/);
  assert.match(astro, /class="hint focus-hint">\{Wl\.email\.hint\}/);
  assert.match(astro, /\.focus-hint \{\s*display: none;/);
  assert.doesNotMatch(astro, /data-terms|stored as|data-door|t-line/);
});

test('both checkboxes stay: jurisdiction and the explicit email consent with the privacy-notice link', () => {
  assert.match(astro, /id="wl-jurisdiction" name="jurisdiction" type="checkbox" required/);
  assert.match(astro, /id="wl-consent" name="consent" type="checkbox" required/);
  assert.match(astro, /<a href="\/privacy">\{Wl\.consent\.link\}<\/a>/);
});

test("Turnstile renders with appearance 'interaction-only'", () => {
  assert.match(client, /appearance: 'interaction-only'/);
});
