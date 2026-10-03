// Checks the built site (dist/) against the page contract (build spec 2.16 #3). Exit 1 on any finding:
//  - an inline <script> (every script must have src: the CSP has no 'unsafe-inline' for scripts)
//  - data: or blob: URLs in HTML or CSS (the CSP allows neither)
//  - an absolute URL outside the allowed third parties (testnet RPCs, Turnstile, the two contact links)
//  - a block-explorer-like link (purrsec, hyperpc, explorer, scan) in any href
//  - an uncompiled :global( in a stylesheet (Astro does not expand it inside :not(); the rule is dropped)
// Also prints every <script src> per page.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const ALLOWED = ['rpcs.chain.link', 'rpc.hyperliquid-testnet.xyz', 'challenges.cloudflare.com', 't.me/godsonits', 'x.com/ggodsonits',
  // the two Cloudflare pages the privacy notice links to
  'www.cloudflare.com/turnstile-privacy-policy/', 'www.cloudflare.com/cloudflare-customer-dpa/'];
// Strings in the self-hosted three.js chunk that look like URLs but are never fetched: the XHTML namespace passed
// to createElementNS, and a paper reference in a comment inside a GLSL shader string. Only in .js files.
const NOT_FETCHED = ['www.w3.org/1999/xhtml', 'jcgt.org/published/0007/04/01/'];
const files = (d, out = []) => {
  for (const n of readdirSync(d)) {
    const p = path.join(d, n);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
};
const findings = [];
const add = (f, what) => findings.push(`${path.relative(DIST, f)}: ${what}`);

for (const f of files(DIST)) {
  if (!/\.(html|css|js)$/.test(f)) continue;
  const t = readFileSync(f, 'utf8');
  if (f.endsWith('.html')) {
    for (const m of t.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (!/\bsrc=/.test(m[1])) add(f, `inline <script>: ${m[2].slice(0, 60)}`);
      else console.log(`${path.relative(DIST, f)}  <script ${m[1].trim()}>`);
    }
    for (const m of t.matchAll(/href=["']([^"']*)["']/gi))
      if (/purrsec|hyperpc|explorer|scan/i.test(m[1])) add(f, `explorer-like href ${m[1]}`);
  }
  if (/\.(html|css)$/.test(f) && /(["'(\s=]|^)(data|blob):/im.test(t)) add(f, 'data: or blob: URL');
  // Astro leaves :global() unexpanded inside :not(); the browser then drops the whole rule
  if (/\.(html|css)$/.test(f) && /:global\(/.test(t)) add(f, 'uncompiled :global( selector (the browser drops that rule)');
  for (const m of t.matchAll(/\b(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})(\/[^\s"'`)<>]*)?/gi)) {
    const url = m[1] + (m[2] ?? '');
    if (f.endsWith('.js') && NOT_FETCHED.includes(url)) continue;
    if (!ALLOWED.some((a) => url === a || url.startsWith(`${a}/`) || (a.includes('/') && url.startsWith(a))))
      add(f, `absolute URL ${m[0]}`);
  }
}
if (findings.length) {
  console.error(`check-dist: ${findings.length} finding(s)\n  ${findings.join('\n  ')}`);
  process.exit(1);
}
console.log('check-dist: ok (no inline scripts, no data:/blob:, only allowed origins, no explorer links)');
