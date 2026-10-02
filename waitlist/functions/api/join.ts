// Copied from site/functions/api/join.ts (waitlist v2 build, 2026-10-02); keep in sync with the original.
// Cloudflare Pages Function: POST /api/join (waitlist signup). Logic and tests live in src/server/waitlist.ts.
// Bindings (site/wrangler.toml + Pages secrets): DB (D1), TURNSTILE_SECRET, IP_HASH_SALT.
import { handleJoin, turnstileVerifier, type JoinEnv } from '../../src/server/waitlist.ts';

const verify = turnstileVerifier();

export const onRequestPost = (ctx: { request: Request; env: JoinEnv }) =>
  handleJoin(ctx.request, ctx.env, { verify, now: () => Date.now() });

export const onRequest = () =>
  new Response(JSON.stringify({ ok: false, error: 'method' }), {
    status: 405,
    headers: { allow: 'POST', 'content-type': 'application/json; charset=utf-8' },
  });
