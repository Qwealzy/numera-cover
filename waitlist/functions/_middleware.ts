// Cloudflare Pages middleware: runs before static assets and /api/*. Redirects the production pages.dev host to the canonical
// domain (logic and tests: src/server/redirect.ts); everything else continues untouched, so _headers still applies to assets.
import { canonicalRedirect } from '../src/server/redirect.ts';

export const onRequest = (ctx: { request: Request; next: () => Promise<Response> }) =>
  canonicalRedirect(ctx.request) ?? ctx.next();
