// node --test: the Proof section shows the recorded run as a static block track and receipt cards only. No
// transaction hash, no `cast receipt` line and no copy button reach the page, and no client code touches the
// clipboard. The built page is checked when a build exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(SITE, p), 'utf8');

test('Proof markup: no hashes, no verify line, no copy button, no playhead', () => {
  const t = read('src/components/Proof.astro');
  for (const re of [/\.hash\b/, /cast receipt/, /data-copy/, /data-copied/, /VERIFY_RPC/, /data-run-playhead/])
    assert.doesNotMatch(t, re);
});

test('client code: proof.ts is gone and nothing uses the clipboard', () => {
  assert.equal(existsSync(path.join(SITE, 'src/client/proof.ts')), false);
  for (const f of readdirSync(path.join(SITE, 'src/client'))) {
    const t = read(`src/client/${f}`);
    assert.doesNotMatch(t, /clipboard|execCommand/i, f);
  }
});

test('built index: no 32-byte hex hash and no cast receipt command', () => {
  const f = path.join(SITE, 'dist', 'index.html');
  if (!existsSync(f)) return;
  const html = readFileSync(f, 'utf8');
  assert.doesNotMatch(html, /0x[0-9a-f]{64}/i);
  assert.doesNotMatch(html, /cast receipt/);
});
