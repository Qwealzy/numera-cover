// Adapted from site/test/contrast.test.mjs to the v2 tokens: WCAG AA contrast of the text tokens in
// src/styles/tokens.css on every surface they sit on, the green UI edge, and the brand rule that every colour
// token is a palette colour (or the ground) at some alpha. No red, no orange.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
const tok = Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

function parse(v) {
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = v.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  throw new Error(`cannot parse colour ${v}`);
}
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = (c) => {
  const [r, g, b] = c.slice(0, 3).map((x) => {
    x /= 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const PALETTE = { navy: '#435c7a', 'navy-deep': '#22374e', green: '#23b779', 'green-deep': '#178a57', paper: '#f8f2ef', bg: '#0c1520' };
const bg = parse(tok.bg);
const surfaces = {
  bg,
  surface: over(parse(tok.surface), bg),
  'surface-strong': over(parse(tok['surface-strong']), bg),
  'navy-fill': over(parse(tok['navy-fill']), bg), // the liquidation zone under the instrument labels
};

test('text tokens reach WCAG AA (4.5:1) on every surface', () => {
  for (const name of ['text-strong', 'text', 'text-label', 'text-accent']) {
    for (const [sn, s] of Object.entries(surfaces)) {
      const r = ratio(over(parse(tok[name]), s), s);
      assert.ok(r >= 4.5, `${name} on ${sn}: ${r.toFixed(2)}`);
    }
  }
});

// The join section has the Numera mark behind it at --join-mark-opacity. Worst case for the text there: the
// mark's brightest pixel, taken as pure white (a lit 3D face can be brighter than any palette colour), at that
// opacity over the ground. The section text sits on that directly; the form sits on the ticket's --surface-join
// backing over it.
const markA = Number(tok['join-mark-opacity']);
const markWorst = over([255, 255, 255, markA], bg);
const joinSurfaces = {
  'join mark (worst pixel)': markWorst,
  'join ticket backing over the mark': over(parse(tok['surface-join']), markWorst),
  'join ticket backing over the ground': over(parse(tok['surface-join']), bg),
};

test('join section: the mark opacity is a token in (0, 0.35]', () => {
  assert.ok(markA > 0 && markA <= 0.35, `--join-mark-opacity ${tok['join-mark-opacity']}`);
});

test('join section: text tokens reach WCAG AA over the mark and over the ticket backing', () => {
  for (const name of ['text-strong', 'text', 'text-label', 'text-accent']) {
    for (const [sn, s] of Object.entries(joinSurfaces)) {
      const r = ratio(over(parse(tok[name]), s), s);
      assert.ok(r >= 4.5, `${name} on ${sn}: ${r.toFixed(2)}`);
    }
  }
  // the button text on green and the green UI edge, inside the ticket
  for (const [sn, s] of Object.entries(joinSurfaces)) assert.ok(ratio(parse(tok.green), s) >= 3, `green edge on ${sn}`);
});

test('button text on green is at least 4.5:1; green as a UI edge is at least 3:1 on every surface', () => {
  assert.ok(ratio(parse(tok['on-accent']), parse(tok.green)) >= 4.5);
  for (const [sn, s] of Object.entries(surfaces)) assert.ok(ratio(parse(tok.green), s) >= 3, `green edge on ${sn}`);
});

test('brand palette exact; every colour token is a palette colour at some alpha; no red or orange', () => {
  assert.deepEqual(
    ['navy', 'navy-deep', 'green', 'green-deep', 'paper', 'bg'].map((k) => tok[k].toLowerCase()),
    Object.values(PALETTE),
  );
  const rgbs = Object.values(PALETTE).map((h) => parse(h).slice(0, 3).join(','));
  for (const [k, v] of Object.entries(tok)) {
    let c;
    try {
      c = parse(v);
    } catch {
      continue;
    }
    assert.ok(rgbs.includes(c.slice(0, 3).join(',')), `--${k} ${v} is not a palette colour`);
    const [r, g, b] = c;
    assert.ok(!(r > 150 && r > g * 1.4 && r > b * 1.4), `--${k} ${v} reads as red/orange`);
  }
});

export { ratio, parse, over };
