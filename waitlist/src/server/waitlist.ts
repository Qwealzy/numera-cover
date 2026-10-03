// Started from site/src/server/waitlist.ts (waitlist v2 build, 2026-10-02). Since 2026-10-03 it diverges: email
// is required (unique on the normalised address); a Telegram username and an X handle are each optional, and a
// signup may give both (migration 0002).
// Waitlist signup logic for the Cloudflare Pages Function functions/api/join.ts.
// Pure and dependency-free so node --test can run it with a fake D1 and a fake Turnstile (test/waitlist.test.ts).
// Only erasable TypeScript syntax (Node strips the types when it runs the tests).
import { CONSENT_VERSIONS } from '../copy/en.ts';

export type Channel = 'telegram' | 'x';
export const CHANNELS: readonly Channel[] = ['telegram', 'x'];

export const LIMITS = {
  bodyBytes: 4096, // a valid body is ~2.5 kB at most (Turnstile tokens run to ~2 kB)
  handleChars: 64, // raw input, before normalisation
  emailChars: 254, // RFC 5321 path limit, after trimming
  tokenChars: 2048,
  perHour: 5, // requests per salted IP hash per rolling hour
  hourSec: 3600,
  ipHashKeepSec: 86400, // attempt rows older than this are deleted
};

// Telegram usernames: 5-32 of [A-Za-z0-9_], starting with a letter. X handles: 1-15 of [A-Za-z0-9_].
const HANDLE_RE: Record<Channel, RegExp> = {
  telegram: /^[a-z][a-z0-9_]{4,31}$/,
  x: /^[a-z0-9_]{1,15}$/,
};
const PREFIX: Record<Channel, string> = { telegram: 'tg', x: 'x' };

/** Normalised key "tg:<name>" / "x:<name>" (lowercase, no @, no profile URL), or null if invalid. */
export function normalizeHandle(raw: unknown, channel: Channel): string | null {
  if (typeof raw !== 'string' || raw.length > LIMITS.handleChars) return null;
  let h = raw.trim().toLowerCase();
  h = h.replace(/^https?:\/\//, '').replace(/^(www\.)?(t\.me|telegram\.me|x\.com|twitter\.com)\//, '');
  h = h.replace(/^@/, '').replace(/\/$/, '');
  return HANDLE_RE[channel].test(h) ? `${PREFIX[channel]}:${h}` : null;
}

// A pragmatic address check, no MX lookup: a local part of 1-64 common characters without leading, trailing or
// double dots, an @, and a domain of letter/digit/hyphen labels with a 2-63 letter top-level label.
const EMAIL_LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const EMAIL_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Normalised address (trimmed, lowercased; dots and +tags kept), or null if it does not look deliverable. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (!e || e.length > LIMITS.emailChars) return null;
  const at = e.lastIndexOf('@');
  if (at < 1 || e.indexOf('@') !== at) return null;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (local.length > 64 || domain.length > 253) return null;
  return EMAIL_LOCAL.test(local) && EMAIL_DOMAIN.test(domain) ? e : null;
}

/** An optional handle field: absent, null or blank -> null; otherwise the bare normalised name (lowercase, no @,
 *  no URL, no "tg:"/"x:" prefix: the column says which network), or false when it is invalid. */
export function optionalHandle(raw: unknown, channel: Channel): string | null | false {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return null;
  const n = normalizeHandle(raw, channel);
  return n ? n.slice(n.indexOf(':') + 1) : false;
}

export type Signup = {
  email: string;
  telegram: string | null; // bare username, or null when not given
  x: string | null;
  consentVersion: string;
  token: string;
};
export type Invalid = { error: 'email' | 'telegram' | 'x' | 'consent' | 'jurisdiction' | 'captcha' | 'body' };

/** Country codes (ISO 3166-1 alpha-2) the join endpoint refuses: the US (Hyperliquid Terms 1.6, docs/research/hyperliquid.md),
 *  the UK (FCA financial-promotion rules reach overseas websites), and the comprehensively sanctioned countries
 *  Cuba, Iran, North Korea and Syria. Ontario cannot be told apart by country: the jurisdiction checkbox covers it.
 *  A missing or unknown country (local dev, "XX", "T1" = Tor) is not refused here; the checkbox decides. */
export const BLOCKED_REGIONS: readonly string[] = ['US', 'GB', 'CU', 'IR', 'KP', 'SY'];

/** The visitor's country: Cloudflare's cf-ipcountry header (set on every proxied request), else request.cf.country.
 *  -> upper-case code, or '' when unknown. */
export function requestCountry(request: Request): string {
  const h = request.headers.get('cf-ipcountry');
  const c = (h || (request as Request & { cf?: { country?: string } }).cf?.country || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : '';
}
export const regionBlocked = (request: Request): boolean => BLOCKED_REGIONS.includes(requestCountry(request));

/** Validates a parsed JSON body. -> Signup, or { error } naming the first failing field. The email is required;
 *  `telegram` and `x` are each optional and validated with the same rules as before when present. */
export function validateSignup(body: unknown): Signup | Invalid {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body' };
  const b = body as Record<string, unknown>;
  const email = normalizeEmail(b.email);
  if (!email) return { error: 'email' };
  const telegram = optionalHandle(b.telegram, 'telegram');
  if (telegram === false) return { error: 'telegram' };
  const x = optionalHandle(b.x, 'x');
  if (x === false) return { error: 'x' };
  if (b.consent !== true || typeof b.consentVersion !== 'string' || !CONSENT_VERSIONS.includes(b.consentVersion))
    return { error: 'consent' };
  if (b.jurisdiction !== true) return { error: 'jurisdiction' };
  const token = b.turnstileToken;
  if (typeof token !== 'string' || !token || token.length > LIMITS.tokenChars) return { error: 'captcha' };
  return { email, telegram, x, consentVersion: b.consentVersion, token };
}

/** Salted SHA-256 of the client IP, hex (the IP itself is never stored). */
export async function ipHash(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}|${ip}`);
  const d = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---- Cloudflare bindings, typed only as far as this file uses them ----
export interface D1Stmt {
  bind(...v: unknown[]): D1Stmt;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface D1Like {
  prepare(sql: string): D1Stmt;
}
export type VerifyTurnstile = (token: string, secret: string, ip: string) => Promise<boolean>;

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function turnstileVerifier(fetchFn: typeof fetch = fetch): VerifyTurnstile {
  return async (token, secret, ip) => {
    const form = new FormData();
    form.append('secret', secret);
    form.append('response', token);
    if (ip) form.append('remoteip', ip);
    try {
      const r = await fetchFn(SITEVERIFY_URL, { method: 'POST', body: form });
      if (!r.ok) return false;
      const j = (await r.json()) as { success?: boolean };
      return j.success === true;
    } catch {
      return false;
    }
  };
}

export type JoinEnv = { DB?: D1Like; TURNSTILE_SECRET?: string; IP_HASH_SALT?: string };
export type JoinDeps = { verify: VerifyTurnstile; now: () => number };

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/**
 * POST /api/join. Order: config -> content type -> size -> country (region) -> rate limit (every attempt counts) -> validation
 * -> Turnstile -> insert. A duplicate email returns the same success as a new one (no enumeration) and changes
 * nothing stored.
 * Responses: 200 {ok:true} | 400 {ok:false,error} | 403 captcha or region | 413 | 415 | 429 rate | 500 config/db.
 */
export async function handleJoin(request: Request, env: JoinEnv, deps: JoinDeps): Promise<Response> {
  const db = env.DB;
  const secret = env.TURNSTILE_SECRET ?? '';
  const salt = env.IP_HASH_SALT ?? '';
  if (!db || !secret || !salt) return json(500, { ok: false, error: 'config' });

  // JSON only: a cross-site form post cannot send it without a CORS preflight, which this endpoint never grants.
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
    return json(415, { ok: false, error: 'body' });
  const text = await request.text();
  if (new TextEncoder().encode(text).length > LIMITS.bodyBytes) return json(413, { ok: false, error: 'body' });

  // soft block by country before anything is stored (not even the rate-limit row); the checkbox covers the rest
  if (regionBlocked(request)) return json(403, { ok: false, error: 'region' });

  const now = Math.floor(deps.now() / 1000);
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const hash = await ipHash(ip || 'unknown', salt);
  try {
    await db.prepare('DELETE FROM join_attempts WHERE created_at < ?').bind(now - LIMITS.ipHashKeepSec).run();
    const row = await db
      .prepare('SELECT COUNT(*) AS n FROM join_attempts WHERE ip_hash = ? AND created_at > ?')
      .bind(hash, now - LIMITS.hourSec)
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= LIMITS.perHour) return json(429, { ok: false, error: 'rate' });
    await db.prepare('INSERT INTO join_attempts (ip_hash, created_at) VALUES (?, ?)').bind(hash, now).run();
  } catch {
    return json(500, { ok: false, error: 'db' });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: 'body' });
  }
  const v = validateSignup(body);
  if ('error' in v) return json(v.error === 'captcha' ? 403 : 400, { ok: false, error: v.error });

  if (!(await deps.verify(v.token, secret, ip))) return json(403, { ok: false, error: 'captcha' });

  try {
    await db
      .prepare(
        'INSERT INTO waitlist (email, telegram, x, consent_version, jurisdiction_ok, created_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(email) DO NOTHING',
      )
      .bind(v.email, v.telegram, v.x, v.consentVersion, now)
      .run();
  } catch {
    return json(500, { ok: false, error: 'db' });
  }
  return json(200, { ok: true });
}
