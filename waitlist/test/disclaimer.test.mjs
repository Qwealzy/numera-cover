// node --test: the disclaimer is on every built page (footer pill; the home page's hero pill too) and the
// footer says the project is not affiliated with Hyperliquid. Skipped without a build (npm run build first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hero, footer } from '../src/copy/en.ts';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(SITE, 'dist');
const text = (html) => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('the disclaimer wording', () => {
  assert.equal(
    hero.status,
    'Testnet only · Mock funds, no real payout · Not insurance · Not an offer · Not available to US, UK or Ontario persons or sanctioned jurisdictions',
  );
  assert.equal(footer.affiliation, 'Not affiliated with or endorsed by Hyperliquid.');
});

test('every built HTML page carries the disclaimer and the no-affiliation line in its footer', { skip: !existsSync(DIST) }, () => {
  const pages = readdirSync(DIST).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length >= 3, `expected the built pages, got ${pages.join(', ')}`);
  for (const f of pages) {
    const html = readFileSync(path.join(DIST, f), 'utf8');
    const foot = text(html.match(/<footer[\s\S]*<\/footer>/)?.[0] ?? '');
    assert.ok(foot.includes(hero.status), `${f}: disclaimer missing from the footer`);
    assert.ok(foot.includes(footer.affiliation), `${f}: no-affiliation line missing from the footer`);
  }
  assert.ok(text(readFileSync(path.join(DIST, 'index.html'), 'utf8')).split(hero.status).length >= 3, 'index.html: hero badge and footer badge');
});
