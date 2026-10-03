// Legal wording rule (D28): the app shows no insurance vocabulary. Scans the visible text of the app source:
// string literals and JSX text of every .tsx screen/component, the user-facing strings of lib/errors.ts, lib/copy.ts,
// lib/quote.ts blockers, plus index.html and the calibration prose. Test files, generated ABIs/deployments and
// comments are not scanned; code identifiers (premium, minPremiumBps, claimWindow, claimPayout...) are not text.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISCLAIMER, argLabel } from './copy';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.resolve(SRC, '..');

const BANNED = /\bpremium(s)?\b|\bpolic(y|ies)\b|\bclaim(s|ed|ing)?\b|\binsur(ed|er|ers|ance|e|es)\b|\bprotect\w*|\bindemni\w*/i;
// the only allowed use of the word: the disclaimer phrase
// ${...} expressions in template literals are code (identifiers such as quote.premium), not text
const stripExprs = (t: string) => {
  let prev = '';
  while (prev !== t) {
    prev = t;
    t = t.replace(/\$\{[^${}]*\}/g, ' ');
  }
  return t;
};
const strip = (t: string) => stripExprs(t).replace(/\bnot insurance\b/gi, ' ');

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (f === 'generated' || f === 'fixtures') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Quoted string literals + JSX text nodes of a TS/TSX source, with comments removed. */
function visibleText(src: string): string[] {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  const out: string[] = [];
  for (const m of noComments.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  for (const m of noComments.matchAll(/>([^<>{}\n][^<>{}]*)</g)) out.push(m[1]);
  return out;
}

// string literals that are code identifiers, not text a visitor reads
const IDENT = /^(premium|minPremiumBps|unearnedPremium|claimWindow|claimDeadline|claimableAt|claimable|claimPayout|claimShares|claimAssets|PremiumBelowFloor|RequestClaimable|RequestNotClaimable|ExceedsClaimable|CoverPurchased\(.*\))$/;
const isIdent = (t: string) => IDENT.test(t.trim()) || /^[a-z]+:.*|^event |^function /.test(t) || t.includes('uint256') || t.includes('uint64');

describe('wording (no insurance vocabulary in visible text)', () => {
  const files = walk(SRC).filter((f) => /\.(tsx|ts)$/.test(f) && !/\.test\./.test(f));

  it('scans a non-trivial set of files', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith('BuyCover.tsx'))).toBe(true);
  });

  for (const f of files) {
    it(`visible strings of ${path.relative(SRC, f).split(path.sep).join('/')}`, () => {
      const bad = visibleText(readFileSync(f, 'utf8'))
        .filter((t) => !isIdent(t))
        .map(strip)
        .filter((t) => BANNED.test(t));
      expect(bad).toEqual([]);
    });
  }

  // generated/ is skipped by the file walk above; its prose fields (deployments `purpose`, `note`, `proof`, `kind`,
  // `contract`) are scanned here, and the UI must never render them as-is (only the typed fields it names).
  it('generated deployments prose fields carry no insurance vocabulary', () => {
    const gen = readFileSync(path.join(SRC, 'generated', 'deployments.ts'), 'utf8');
    const prose = [...gen.matchAll(/"(?:purpose|note|proof|kind|contract|label|name)":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    expect(prose.length).toBeGreaterThan(10);
    expect(prose.map(strip).filter((t) => BANNED.test(t))).toEqual([]);
  });

  it('no app source outside generated/ reads a deployments prose field to render it', () => {
    const readers = files.filter((f) => /\.(purpose|note|proof)\b/.test(readFileSync(f, 'utf8')));
    expect(readers.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('index.html (title, meta description, body text)', () => {
    expect(BANNED.test(strip(readFileSync(path.join(APP, 'index.html'), 'utf8')))).toBe(false);
  });

  it('the shared disclaimer is the site text and "insurance" appears only in "not insurance"', () => {
    expect(DISCLAIMER).toBe(
      'Testnet only · Mock funds, no real payout · Not insurance · Not an offer · Not available to US, UK or Ontario persons or sanctioned jurisdictions',
    );
    expect(BANNED.test(strip(DISCLAIMER))).toBe(false);
  });

  it('ABI field "premium" is shown as "cover price" in decoded receipts', () => {
    expect(argLabel('premium')).toBe('cover price');
    expect(argLabel('payout')).toBe('payout');
  });
});
