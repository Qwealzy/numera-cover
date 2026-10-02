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
// the only allowed matches: exact legal names in the privacy notice
const LEGAL_NAMES = /data protection authority|Protection of Personal Data/g;

/** All copy as one string, including the template functions called with sample values. */
function copyText(): string {
  return [JSON.stringify(en), en.readout.uw('$2.44'), en.readout.uwRefused, en.underwriters.toy.status(3)].join('\n');
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
    const t = get().replace(LEGAL_NAMES, '');
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

test('privacy notice: version bumped for the reworded Recipients sentence; the old version still accepted', () => {
  assert.equal(en.CONSENT_VERSION, 'privacy-2026-10-02-v2');
  assert.ok(en.CONSENT_VERSIONS.includes('privacy-2026-10-02'));
  assert.equal(en.privacy.updated, 'Version privacy-2026-10-02-v2');
  const rec = en.privacy.sections.find((s) => s.h === 'Recipients')!;
  assert.match(rec.p[1], /pool statistics, oracle prices and perp data/);
  const body = (v: string) => ({
    handle: '@alice_trader',
    channel: 'telegram',
    consent: true,
    consentVersion: v,
    jurisdiction: true,
    turnstileToken: 'tok',
  });
  for (const v of ['privacy-2026-10-02', 'privacy-2026-10-02-v2']) assert.ok(!('error' in validateSignup(body(v))), v);
  assert.deepEqual(validateSignup(body('privacy-2026-09-30')), { error: 'consent' });
});

test('the waitlist wording and messages are verbatim from site/', () => {
  assert.equal(en.waitlist.success, 'You are on the list. We will reach out on the channel you chose.');
  assert.equal(en.waitlist.noscript, 'The waitlist form needs JavaScript for its spam check. You can also message @godsonits on Telegram.');
  assert.equal(en.waitlist.jurisdiction, 'I am not a resident of, located in, or a citizen of the US, Ontario (Canada) or a sanctioned jurisdiction.');
  assert.deepEqual(Object.keys(en.waitlist.errors).sort(), ['captcha', 'consent', 'generic', 'handle', 'jurisdiction', 'rate']);
  assert.equal(en.stats.note.endsWith('A dash means the read failed; no number is ever filled in.'), true);
});
