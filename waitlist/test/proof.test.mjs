// node --test: the Proof section shows the recorded run as a block track and receipt cards, animated by
// src/client/proof.ts. No transaction hash, no `cast receipt` line and no copy button reach the page, and no
// client code touches the clipboard. The built page is checked when a build exists.
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

test('client code: nothing uses the clipboard; the run animates through the shared scheduler', () => {
  const run = read('src/client/proof.ts');
  assert.match(run, /loop\('proof-run', run,/);
  assert.match(run, /if \(motionOn\(\)\) \{[\s\S]*\} else end\(\);/, 'reduced motion: the finished run');
  for (const f of readdirSync(path.join(SITE, 'src/client'))) {
    const t = read(`src/client/${f}`);
    assert.doesNotMatch(t, /clipboard|execCommand/i, f);
  }
});

test('Proof markup is the finished run (no JS, reduced motion): every block and card reached, bracket on', () => {
  const t = read('src/components/Proof.astro');
  assert.match(t, /data-run data-bracket="on"/);
  assert.match(t, /data-ev=\{ev \? 'y' : 'n'\} data-reached="y"/);
  assert.match(t, /data-rc-block=\{e\.block\} data-reached="y"/);
});

test('built index: no 32-byte hex hash and no cast receipt command', () => {
  const f = path.join(SITE, 'dist', 'index.html');
  if (!existsSync(f)) return;
  const html = readFileSync(f, 'utf8');
  assert.doesNotMatch(html, /0x[0-9a-f]{64}/i);
  assert.doesNotMatch(html, /cast receipt/);
});
