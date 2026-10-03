// node --test: the extra copy rules of the v2 build spec (2.14), over the copy module and, when a build exists,
// over the visible text of every built page. Also the privacy-notice version bump and the server accepting
// the previous version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as en from '../src/copy/en.ts';
import { validateSignup } from '../src/server/waitlist.ts';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(SITE, 'dist');

// claims the brand never makes (protect*, risk-free, safe*, revolutionary, APY, "yield of")
const EXTRA = /\bprotect(ed|s|ion|ing)?\b|\brisk-free\b|\bsafe(ly|ty)?\b|\brevolutionary\b|\bAPY\b|\byield of\b/i;
// Insurance wording (insurance-law risk, D28; founder decision 2026-10-03). The only allowed use of "insurance" is
// the exact phrase "not insurance". Data that engine/deployment records name "premium" keeps its internal
// identifiers, but nothing a visitor sees or a screen reader announces may use these words.
const NOT_INSURANCE = /\bnot insurance\b/gi;
// Exact contract identifiers that may appear in code style (CoverPool v2 immutable `claimWindow`, deployments/testnet-v2.json).
// An explicit list of exact names: the word "claim" in prose stays banned.
const ALLOWED_IDENTIFIERS = ['claimWindow'];
const stripIdentifiers = (t: string) => ALLOWED_IDENTIFIERS.reduce((a, id) => a.split(id).join(' '), t);
export const INSURANCE_WORDS = /\bpremium(s)?\b|\bpolic(y|ies)\b|\bclaim(s|ed|ing)?\b|\binsur(ed|er|ers|ance|e|es)\b|\bprotect\w*|\bindemni\w*/i;

/** Every string value of the copy module (functions are called with sample arguments), keys excluded. */
function copyStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (typeof v === 'function') {
    try {
      out.push(...copyStrings((v as (...a: unknown[]) => unknown)('$2.44', '7.95 %', 3), []));
    } catch {
      // not a template
    }
  } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'href') copyStrings(x, out); // a URL is an identifier, not copy
  return out;
}
/** Text-bearing attributes of the built pages (aria-label, title, alt, placeholder, meta content). */
function distAttrText(): string {
  if (!existsSync(DIST)) return '';
  return readdirSync(DIST)
    .filter((f) => f.endsWith('.html'))
    .map((f) =>
      [...readFileSync(path.join(DIST, f), 'utf8').matchAll(/\s(?:aria-label|aria-description|title|alt|placeholder|data-errors|data-success)="([^"]*)"|<meta\s+(?:name|property)="(?:description|og:[a-z:]+|twitter:[a-z:]+)"\s+content="([^"]*)"/g)]
        .map((m) => m[1] ?? m[2])
        .join(' | '),
    )
    .join(' | ');
}

/** All copy as one string, including the template functions called with sample values. */
function copyText(): string {
  const I = en.instrument;
  return [
    JSON.stringify(en),
    en.readout.uw('$2.44'),
    en.readout.uwRefused,
    en.underwriters.toy.status(3),
    I.poolSold('$2.44'),
    I.poolPaid('$2.44'),
    I.verdicts.refused(I.verdicts.reasonLevel),
    en.price.you.here('$2.44', '7.95 %'),
    en.price.you.between('7.95 %'),
  ].join('\n');
}
/** Visible text of the built pages (tags, scripts and styles removed), or '' without a build. */
function distText(): string {
  if (!existsSync(DIST)) return '';
  return readdirSync(DIST)
    .filter((f) => f.endsWith('.html'))
    .map((f) =>
      readFileSync(path.join(DIST, f), 'utf8')
        .replace(/<style[\s\S]*?<\/style>/g, ' ')
        .replace(/<script[\s\S]*?<\/script>/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"'),
    )
    .join('\n');
}

for (const [name, get] of [
  ['copy module', copyText],
  ['built pages', distText],
] as const) {
  test(`${name}: no protect/risk-free/safe/revolutionary/APY/yield-of wording`, () => {
    const t = get();
    const m = t.match(EXTRA);
    assert.equal(m, null, m ? `found "${m[0]}" near: ${t.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + 60)}` : '');
  });
  test(`${name}: "audited" only as "not audited"; no $0.01 or $0.04; no email; only the two handles`, () => {
    const t = get();
    assert.equal(t.replace(/not audited/gi, '').match(/audited/i), null);
    assert.doesNotMatch(t, /\$0\.0[14]\b/);
    assert.doesNotMatch(t, /[a-z0-9._%+-]+@[a-z0-9-]+\.[a-z]{2,}/i);
    const handles = new Set([...t.matchAll(/@([A-Za-z0-9_]{3,})/g)].map((m) => m[1]));
    for (const h of handles) assert.ok(['godsonits', 'ggodsonits'].includes(h), `unexpected handle @${h}`);
  });
  test(`${name}: no traction, yield or affiliation claims`, () => {
    const t = get();
    for (const re of [/\bTVL\b/, /spots? left/i, /\breferr(al|ed)\b/i, /testimonial/i, /\bwinner\b/i, /\bbacked\b/i, /\bmainnet (is )?live\b/i, /real money/i, /\bguarantee/i])
      assert.doesNotMatch(t, re);
  });
}

for (const [name, get] of [
  ['copy module', () => copyStrings(en).join(' | ')],
  ['built pages (visible text)', distText],
  ['built pages (aria labels, titles, meta tags)', distAttrText],
] as const)
  test(`${name}: no premium, policy, claim, insured, insurance (except "not insurance"), protect*, indemnify`, () => {
    const t = stripIdentifiers(get()).replace(NOT_INSURANCE, ' ');
    const m = t.match(INSURANCE_WORDS);
    assert.equal(m, null, m ? `found "${m[0]}" near: ${t.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + 60)}` : '');
  });

test('the insurance-word rule catches each banned word and spares "not insurance"', () => {
  for (const w of ['premium', 'Premiums', 'policy', 'policies', 'claim', 'claimed', 'insured', 'insure' + 'r', 'insurance', 'protect', 'protection', 'protected', 'indemnify', 'indemnity'])
    assert.match(`pay a ${w} now`, INSURANCE_WORDS, w);
  assert.equal('Mock funds. Not insurance. Not an offer.'.replace(NOT_INSURANCE, ' ').match(INSURANCE_WORDS), null);
  assert.match('this is insurance'.replace(NOT_INSURANCE, ' '), INSURANCE_WORDS);
});

test('the identifier allowlist spares exactly claimWindow, not prose', () => {
  assert.equal(stripIdentifiers('withdrawDelay then claimWindow').match(INSURANCE_WORDS), null);
  assert.match(stripIdentifiers('the claim window'), INSURANCE_WORDS);
  assert.match(stripIdentifiers('claimWindows or claim'), INSURANCE_WORDS);
});

test('privacy notice: version bumped for the email; the older versions still accepted', () => {
  assert.equal(en.CONSENT_VERSION, 'privacy-2026-10-03-v5');
  assert.ok(en.CONSENT_VERSIONS.includes('privacy-2026-10-03-v4'));
  assert.ok(en.CONSENT_VERSIONS.includes('privacy-2026-10-03-v3'));
  assert.ok(en.CONSENT_VERSIONS.includes('privacy-2026-10-03-v2'));
  assert.ok(en.CONSENT_VERSIONS.includes('privacy-2026-10-03'));
  assert.ok(en.CONSENT_VERSIONS.includes('privacy-2026-10-02-v2'));
  assert.ok(en.CONSENT_VERSIONS.includes('privacy-2026-10-02'));
  assert.equal(en.privacy.updated, 'Version privacy-2026-10-03-v5');
  const rec = en.privacy.sections.find((s) => s.h === 'Recipients')!;
  // the site reads the pool statistics and the BTC oracle price, nothing else (no perp metadata)
  assert.match(rec.p[1], /^The pool statistics and the BTC oracle price on the home page are read by your browser directly/);
  assert.doesNotMatch(rec.p[1], /perp data/);
  const body = (v: string) => ({
    email: 'alice@example.org',
    consent: true,
    consentVersion: v,
    jurisdiction: true,
    turnstileToken: 'tok',
  });
  for (const v of ['privacy-2026-10-02', 'privacy-2026-10-02-v2', 'privacy-2026-10-03', 'privacy-2026-10-03-v2', 'privacy-2026-10-03-v3', 'privacy-2026-10-03-v4', 'privacy-2026-10-03-v5']) assert.ok(!('error' in validateSignup(body(v))), v);
  assert.deepEqual(validateSignup(body('privacy-2026-09-30')), { error: 'consent' });
});

test('the waitlist wording: email first, honest intro, explicit email consent; other messages verbatim from site/', () => {
  assert.equal(en.waitlist.success, 'You are on the list. We will email you when the next testnet round opens.');
  assert.doesNotMatch(en.waitlist.intro, /no email/i);
  assert.match(en.waitlist.intro, /No wallet, no keys\./);
  // the consent statement names the email and the way out (Law No. 6563: explicit consent to e-messages)
  const consent = en.waitlist.consent.before + en.waitlist.consent.link + en.waitlist.consent.after;
  assert.match(consent, /^Email me when the next testnet round opens, and store my email/);
  assert.match(consent, /privacy notice describes\. I can unsubscribe any time\. This site is used under the $/);
  assert.equal(en.waitlist.consent.termsLink, 'terms of use'); // linked to /terms right after the privacy link
  // the "I would" toggle and its wording are gone
  assert.equal('doors' in en.waitlist, false);
  assert.equal('terms' in en.waitlist, false);
  // the privacy notice: email as a data category, its purpose, its retention and how to unsubscribe
  const notice = JSON.stringify(en.privacy.sections);
  for (const re of [/Your email address/, /Launch and testnet notices only/, /including your email address, are deleted by \{\{DELETE_BY\}\}/, /To unsubscribe/, /Law No\. 6563/])
    assert.match(notice, re);
  assert.equal(en.waitlist.noscript, 'The waitlist form needs JavaScript for its spam check. You can also message @godsonits on Telegram.');
  // exactly the founder's wording (2026-10-03)
  assert.equal(en.waitlist.jurisdiction, 'I am 18 or older, and I am not a resident or citizen of, or located in, the US, the UK, Ontario (Canada) or a sanctioned jurisdiction.');
  assert.deepEqual(Object.keys(en.waitlist.errors).sort(), ['captcha', 'consent', 'email', 'emailEmpty', 'generic', 'jurisdiction', 'rate', 'region', 'telegram', 'x']);
  assert.equal(en.stats.note.endsWith('A dash means the read failed; no number is ever filled in.'), true);
});
