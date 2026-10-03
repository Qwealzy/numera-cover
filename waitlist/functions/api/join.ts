// Email is required; Telegram and X handles are each optional (see src/server/waitlist.ts and migrations/0002_email.sql).
// Cloudflare Pages Function: POST /api/join (waitlist signup). Logic and tests live in src/server/waitlist.ts.
// Bindings (wrangler.toml + Pages secrets): DB (D1), TURNSTILE_SECRET, IP_HASH_SALT; optional var TURNSTILE_HOSTNAMES.
import { handleJoin, turnstileVerifier, type JoinEnv } from '../../src/server/waitlist.ts';

const verify = turnstileVerifier();

export const onRequestPost = (ctx: { request: Request; env: JoinEnv }) =>
  handleJoin(ctx.request, ctx.env, { verify, now: () => Date.now() });

export const onRequest = () =>
  new Response(JSON.stringify({ ok: false, error: 'method' }), {
    status: 405,
    headers: { allow: 'POST', 'content-type': 'application/json; charset=utf-8' },
  });
