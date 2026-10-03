// Production pages.dev host -> canonical custom domain. Only the exact production host redirects: preview.numera-cover.pages.dev,
// <hash>.numera-cover.pages.dev, the canonical host and localhost all pass through.
import { SITE_URL } from '../site.ts';

export const LEGACY_HOST = 'numera-cover.pages.dev';

/** A 301 to the canonical origin (path and query kept) when the request host is exactly LEGACY_HOST, else null. */
export function canonicalRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.hostname.toLowerCase() !== LEGACY_HOST) return null;
  return new Response(null, { status: 301, headers: { location: SITE_URL + url.pathname + url.search } });
}
