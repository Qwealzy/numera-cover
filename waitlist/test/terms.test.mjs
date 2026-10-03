// node --test: the terms of use page (/terms): its sections, the {{GOVERNING_LAW}} placeholder filled from the
// build env, the pending-review badge, the footer link and the link next to the privacy link in the form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terms } from '../src/copy/en.ts';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(SITE, f), 'utf8');

test('terms copy: testnet, mock funds, not insurance, not an offer, not advice, no warranty, liability, eligibility, changes, law, contact', () => {
  const t = JSON.stringify(terms.sections);
  for (const re of [
    /testnet experiment/, /mock USDC/, /It is not insurance\./, /not an offer|Nothing here is an offer/, /financial, investment, legal or tax advice/,
    /No real payout is made or promised/, /without warranty of any kind/, /not liable for any loss or damage/, /18 or older/,
    /the US, the UK, Ontario \(Canada\) or a sanctioned jurisdiction/, /We may change these terms/, /\{\{GOVERNING_LAW\}\}/, /\{\{CONTROLLER_NAME\}\}/, /@godsonits/, /@ggodsonits/,
  ])
    assert.match(t, re);
  for (const h of ['What this is', 'Not insurance', 'Mock funds', 'Who may use it', 'No warranty', 'Limit of liability', 'Changes to these terms', 'Governing law', 'Contact'])
    assert.ok(terms.sections.some((s) => s.h.startsWith(h)), h);
  assert.equal(terms.pending, 'Pending legal review');
});

test('the form links the terms next to the privacy notice; the footer links them on every page', () => {
  assert.match(read('src/components/Waitlist.astro'), /<a href="\/privacy">\{Wl\.consent\.link\}<\/a>\{Wl\.consent\.after\}<a href="\/terms">\{Wl\.consent\.termsLink\}<\/a>/);
  assert.match(read('src/components/Footer.astro'), /<a href="\/terms">\{F\.terms\}<\/a>/);
});

test('built /terms: the pending badge, the sections and a visible governing-law placeholder in a dev build', { skip: !existsSync(path.join(SITE, 'dist/terms.html')) }, () => {
  const html = read('dist/terms.html');
  assert.match(html, /Pending legal review/);
  assert.match(html, /<h1[^>]*>Terms of use<\/h1>/);
  assert.equal((html.match(/<section /g) ?? []).length, terms.sections.length);
  assert.match(html, /governed by the law of (\{\{GOVERNING_LAW\}\}|[^<]+)\./);
});
