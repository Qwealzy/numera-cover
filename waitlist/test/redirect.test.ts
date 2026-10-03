// node --test: only the exact production pages.dev host redirects (301, path and query kept); the middleware passes the rest on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRedirect } from '../src/server/redirect.ts';
import { onRequest } from '../functions/_middleware.ts';

const req = (u: string) => new Request(u);

test('production pages.dev host: 301 to the canonical host with path and query', () => {
  const r = canonicalRedirect(req('https://numera-cover.pages.dev/privacy?a=1&b=x'));
  assert.equal(r?.status, 301);
  assert.equal(r?.headers.get('location'), 'https://cover.numeralabs.xyz/privacy?a=1&b=x');
  assert.equal(canonicalRedirect(req('https://numera-cover.pages.dev/'))?.headers.get('location'), 'https://cover.numeralabs.xyz/');
  assert.equal(canonicalRedirect(req('https://NUMERA-COVER.pages.dev/api/join'))?.status, 301);
});

test('preview, hash preview, canonical, localhost and lookalike hosts pass through', () => {
  for (const u of [
    'https://preview.numera-cover.pages.dev/x?y=1',
    'https://a1b2c3d4.numera-cover.pages.dev/',
    'https://cover.numeralabs.xyz/api/join',
    'http://localhost:4471/',
    'http://127.0.0.1:4471/privacy',
    'https://evil-numera-cover.pages.dev/',
    'https://numera-cover.pages.dev.evil.com/',
  ])
    assert.equal(canonicalRedirect(req(u)), null, u);
});

test('middleware: redirects the legacy host, calls next() otherwise', async () => {
  let called = 0;
  const next = async () => {
    called++;
    return new Response('ok');
  };
  const r = await onRequest({ request: req('https://numera-cover.pages.dev/terms?q=1'), next });
  assert.equal(r.status, 301);
  assert.equal(called, 0);
  const p = await onRequest({ request: req('https://cover.numeralabs.xyz/api/join'), next });
  assert.equal(await p.text(), 'ok');
  assert.equal(called, 1);
});
