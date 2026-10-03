// Build-time settings of the site, including SITE_GOVERNING_LAW for /terms.
// node --test: the production gate on /privacy placeholders and the Turnstile site key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBuildEnv, assertBuildEnv, fillPlaceholders, TURNSTILE_TEST_SITEKEY } from '../src/lib/buildenv.mjs';

const full = {
  SITE_ENV: 'production',
  SITE_CONTROLLER_NAME: 'Example Controller',
  SITE_DELETE_BY: '2027-03-31',
  SITE_GOVERNING_LAW: 'Example Land',
  SITE_SOURCE_URL: 'https://github.com/example/numera-public',
  PUBLIC_TURNSTILE_SITEKEY: '0x4AAAAAAA-real-key',
};

test('dev build: empty values pass, placeholders stay visible, test site key used', () => {
  const b = assertBuildEnv({});
  assert.equal(b.production, false);
  assert.equal(b.turnstileSitekey, TURNSTILE_TEST_SITEKEY);
  assert.equal(b.legalReviewed, false);
  assert.equal(fillPlaceholders('C: {{CONTROLLER_NAME}} by {{DELETE_BY}} under {{GOVERNING_LAW}}', b), 'C: {{CONTROLLER_NAME}} by {{DELETE_BY}} under {{GOVERNING_LAW}}');
});

test('production build fails on each missing or malformed value', () => {
  assert.doesNotThrow(() => assertBuildEnv(full));
  for (const [k, v, re] of [
    ['SITE_CONTROLLER_NAME', '', /SITE_CONTROLLER_NAME is empty/],
    ['SITE_DELETE_BY', '  ', /SITE_DELETE_BY is empty/],
    ['SITE_DELETE_BY', '31.03.2027', /YYYY-MM-DD/],
    ['SITE_GOVERNING_LAW', '', /SITE_GOVERNING_LAW is empty/],
    ['SITE_SOURCE_URL', '', /SITE_SOURCE_URL is empty/],
    ['SITE_SOURCE_URL', 'http://github.com/example/x', /SITE_SOURCE_URL must be an https URL/],
    ['SITE_SOURCE_URL', 'https://user:pw@github.com/example/x', /SITE_SOURCE_URL must be an https URL/],
    ['SITE_SOURCE_URL', 'https://github.com/', /SITE_SOURCE_URL must be an https URL/],
    ['PUBLIC_TURNSTILE_SITEKEY', '', /SITEKEY is empty/],
    ['PUBLIC_TURNSTILE_SITEKEY', TURNSTILE_TEST_SITEKEY, /test key/],
  ]) {
    assert.throws(() => assertBuildEnv({ ...full, [k]: v }), re, `${k}=${v}`);
  }
});

test('production fills the placeholders; SITE_LEGAL_REVIEWED=1 hides the pending note', () => {
  const b = assertBuildEnv({ ...full, SITE_LEGAL_REVIEWED: '1' });
  assert.equal(fillPlaceholders('{{CONTROLLER_NAME}} / {{DELETE_BY}} / {{GOVERNING_LAW}}', b), 'Example Controller / 2027-03-31 / Example Land');
  assert.equal(b.legalReviewed, true);
  assert.equal(readBuildEnv({ ...full, SITE_LEGAL_REVIEWED: 'yes' }).legalReviewed, false);
});
