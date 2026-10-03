// node --test: a state must never be shown by fading text (WCAG AA, hard limit 10). Every CSS rule in the
// components and global styles that sets a partial opacity (between 0 and 1, outside @keyframes) must target a
// decorative element on this allowlist. Text states use colour tokens, shape (dashed outlines, glyphs) or words.
// The two cases a review found (skipped purchase checks at 0.45, receipts not yet reached at 0.45) would fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// decorative only: ambient light and film grain
const DECORATIVE = [/^\.halo$/, /^body::after$/, /^@keyframes/];

function cssOf(file) {
  const t = readFileSync(file, 'utf8');
  if (file.endsWith('.css')) return t;
  return [...t.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
}
/** Flat list of { selector, body } with @keyframes blocks removed and @media/@container unwrapped. */
function rules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // drop @keyframes blocks (their frames animate decoration and transforms)
  let out = '';
  for (let i = 0; i < css.length; ) {
    const k = css.indexOf('@keyframes', i);
    if (k < 0) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, k);
    let depth = 0;
    let j = css.indexOf('{', k);
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) break;
    }
    i = j + 1;
  }
  const list = [];
  for (const m of out.matchAll(/([^{}]+)\{([^{}]*)\}/g)) list.push({ selector: m[1].trim().replace(/^@[^{]*$/, ''), body: m[2] });
  return list;
}

test('no partial opacity on text-bearing elements (only the decorative allowlist)', () => {
  const files = [
    ...readdirSync(path.join(SRC, 'components')).map((f) => path.join(SRC, 'components', f)),
    ...readdirSync(path.join(SRC, 'styles')).map((f) => path.join(SRC, 'styles', f)),
    ...readdirSync(path.join(SRC, 'pages')).map((f) => path.join(SRC, 'pages', f)),
  ].filter((f) => /\.(astro|css)$/.test(f));
  const bad = [];
  for (const f of files)
    for (const r of rules(cssOf(f))) {
      const m = r.body.match(/(?:^|;|\s)opacity\s*:\s*([\d.]+)/);
      if (!m) continue;
      const v = Number(m[1]);
      if (!(v > 0 && v < 1)) continue;
      const sels = r.selector.split(',').map((s) => s.trim().split(/\s+/).pop());
      if (!sels.every((s) => DECORATIVE.some((re) => re.test(s)))) bad.push(`${path.basename(f)}: ${r.selector} { opacity: ${v} }`);
    }
  assert.deepEqual(bad, []);
});
