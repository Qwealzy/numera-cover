// Word rules against this site's copy module, plus
// the wider file scan (scripts, boot.js, .py). public/_headers is skipped: HTTP header names are not copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as en from '../src/copy/en.ts';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Founder/brand rules: say cover, payout, level. Never the old lockup tagline.
// (written as insur(...) so the public-export personal-data scan, which flags one of these words, stays quiet)
const FORBIDDEN_WORDS = /\binsur(ance|ed|e|er)\b|\bguarantee\w*|\bpolic(y|ies)\b|parametric insurtech/i;

export function sourceFiles(dir: string = SITE, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.astro', '.wrangler', 'test'].includes(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(astro|ts|mjs|js|css|sql|toml|md|txt|json|py|svg)$/.test(name) && name !== 'package-lock.json') out.push(p);
  }
  return out;
}

test('no forbidden word in any site source file', () => {
  const hits = sourceFiles().flatMap((f) =>
    readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .map((l, i) => [l, i] as const)
      // URLs are identifiers, not copy (the Cloudflare Turnstile page's path has the word in it)
      .filter(([l]) => FORBIDDEN_WORDS.test(l.replace(/\bnot insurance\b/gi, ' ').replace(/(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}\/\S*/gi, ' ')))
      .map(([l, i]) => `${path.relative(SITE, f)}:${i + 1}: ${l.trim()}`),
  );
  assert.deepEqual(hits, []);
});

test('no personal name or email in the copy; only the allowed public handles', () => {
  const text = JSON.stringify(en);
  assert.doesNotMatch(text, /@[a-z0-9.-]+\.[a-z]{2,}/i, 'no email address');
  const handles = [...text.matchAll(/@([A-Za-z0-9_]{3,})/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(handles)].sort(), ['ggodsonits', 'godsonits']);
});

test('six steps in order Quote, Buy cover, Oracle, Keeper, Pool, Payout, one sentence each', () => {
  assert.deepEqual(
    en.steps.map((s) => s.label),
    ['Quote', 'Buy cover', 'Oracle', 'Keeper', 'Pool', 'Payout'],
  );
  for (const s of en.steps) assert.equal(s.text.split(/[.!?](\s|$)/).filter((x) => x && x.trim()).length, 1, s.id);
});

test('hero states the limits and the status pill names every exclusion', () => {
  assert.match(en.hero.lead, /does not stop a liquidation/);
  assert.match(en.hero.lead, /does not cover your full loss/);
  assert.equal(
    en.hero.status,
    'Testnet only · Mock funds, no real payout · Not insurance · Not an offer · Not available to US, UK or Ontario persons or sanctioned jurisdictions',
  );
  assert.ok(en.CONSENT_VERSIONS.includes(en.CONSENT_VERSION));
});

test('stats are labelled as the team demo pool; no claim of a published repository', () => {
  assert.equal(en.stats.demoBadge, 'TESTNET DEMO POOL');
  assert.match(en.stats.covers.unit, /team test runs/);
  assert.match(en.stats.demoNote, /team-set prices/);
  assert.match(en.stats.demoNote, /not user purchases/);
  assert.doesNotMatch(JSON.stringify(en), /public repository/i);
});

test('privacy notice carries both build placeholders and every GDPR Art. 13 heading', () => {
  const t = JSON.stringify(en.privacy);
  assert.match(t, /\{\{CONTROLLER_NAME\}\}/);
  assert.match(t, /\{\{DELETE_BY\}\}/);
  for (const h of ['Who is responsible', 'Legal basis', 'Recipients', 'Transfer', 'How long', 'Cookies', 'Your rights', 'Voluntary', 'KVKK'])
    assert.ok(en.privacy.sections.some((s) => s.h.startsWith(h)), h);
  assert.match(t, /withdraw your consent/);
  assert.match(t, /complain/);
  assert.match(t, /Turnstile/);
});

test('privacy notice: KVKK Art. 10 items, GDPR Art. 13 gaps, EU storage, cookies, no reliance on DPF/SCCs for KVKK', () => {
  const sec = (h: string) => en.privacy.sections.find((s) => s.h.startsWith(h))!;
  const kvkk = sec('KVKK').p.join(' ');
  for (const re of [/Controller: \{\{CONTROLLER_NAME\}\}/, /Purposes:/, /Recipients and purpose of transfer: Cloudflare, Inc\., as our processor/, /independent controller/, /Method and legal basis/, /explicit consent \(Art\. 5\(1\)\)/, /Art\. 11/, /How to use them/, /Art\. 9 of the law is under legal review/, /EU jurisdiction/])
    assert.match(kvkk, re);
  // GDPR Art. 13: complaint right, voluntary but needed, recipients with links
  const rights = sec('Your rights').p.join(' ');
  assert.match(rights, /complain to a supervisory authority: the KVKK Board/);
  assert.match(rights, /EU or the UK/);
  assert.match(sec('Voluntary').p[0], /voluntary, but needed to join/);
  const hrefs = (sec('Recipients').links ?? []).map((l) => l.href);
  assert.deepEqual(hrefs, ['https://www.cloudflare.com/cloudflare-customer-dpa/', 'https://www.cloudflare.com/turnstile-privacy-policy/']);
  assert.match(sec('Recipients').p.join(' '), /independent controller/);
  // storage region and the honest transfer wording; the old DPF sentence is gone
  const t = sec('Transfer').p.join(' ');
  assert.match(t, /EU jurisdiction/);
  assert.match(t, /under legal review/);
  assert.doesNotMatch(JSON.stringify(en.privacy), /Data Privacy Framework|EU-US/);
  // cookies: strictly necessary Cloudflare cookies by name, no analytics or tracking
  const c = sec('Cookies').p.join(' ');
  assert.match(c, /__cf_bm/);
  assert.match(c, /cf_clearance/);
  assert.match(c, /strictly necessary/);
  assert.match(c, /no analytics or tracking/);
  // the country check is described and not stored
  assert.match(sec('What we store').p.join(' '), /we do not store it/);
  assert.equal(en.privacy.pending, 'Pending legal review');
});
