// Since 2026-10-03 email is required
// (unique on the normalised address); a Telegram username and an X handle are each optional (either, both, none).
// node --test: validation, normalisation and the /api/join handler with a fake D1 and a fake Turnstile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHandle,
  normalizeEmail,
  optionalHandle,
  validateSignup,
  handleJoin,
  ipHash,
  turnstileVerifier,
  requestCountry,
  regionBlocked,
  BLOCKED_REGIONS,
  SITEVERIFY_URL,
  LIMITS,
  type D1Like,
  type D1Stmt,
} from '../src/server/waitlist.ts';
import { CONSENT_VERSION, CONSENT_VERSIONS } from '../src/copy/en.ts';

// ---- fake D1: implements exactly the statements the handler issues ----
type Row = { email: string; telegram: string | null; x: string | null; consent_version: string; jurisdiction_ok: number; created_at: number };
function fakeD1(opts: { failOn?: RegExp } = {}) {
  const waitlist: Row[] = [];
  let attempts: { ip_hash: string; created_at: number }[] = [];
  const sqlLog: string[] = [];
  const db: D1Like = {
    prepare(sql: string): D1Stmt {
      let args: unknown[] = [];
      const stmt: D1Stmt = {
        bind(...v: unknown[]) {
          args = v;
          return stmt;
        },
        async run() {
          sqlLog.push(sql);
          if (opts.failOn?.test(sql)) throw new Error('D1_ERROR');
          if (sql.startsWith('DELETE FROM join_attempts')) attempts = attempts.filter((a) => a.created_at >= (args[0] as number));
          else if (sql.startsWith('INSERT INTO join_attempts')) attempts.push({ ip_hash: args[0] as string, created_at: args[1] as number });
          else if (sql.startsWith('INSERT INTO waitlist')) {
            assert.match(sql, /ON CONFLICT\(email\) DO NOTHING/);
            assert.match(sql, /^INSERT INTO waitlist \(email, telegram, x, consent_version, jurisdiction_ok, created_at\)/);
            const [email, telegram, x, consent_version, created_at] = args as [string, string | null, string | null, string, number];
            if (!waitlist.some((r) => r.email === email))
              waitlist.push({ email, telegram, x, consent_version, jurisdiction_ok: 1, created_at });
          } else throw new Error(`unexpected run: ${sql}`);
          return {};
        },
        async first<T>() {
          sqlLog.push(sql);
          if (opts.failOn?.test(sql)) throw new Error('D1_ERROR');
          if (sql.startsWith('SELECT COUNT(*) AS n FROM join_attempts')) {
            const n = attempts.filter((a) => a.ip_hash === args[0] && a.created_at > (args[1] as number)).length;
            return { n } as T;
          }
          throw new Error(`unexpected first: ${sql}`);
        },
      };
      return stmt;
    },
  };
  return { db, waitlist, attempts: () => attempts, sqlLog };
}

const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);
const goodBody = (over: Record<string, unknown> = {}) => ({
  email: 'alice@example.org',
  telegram: '@Alice_Trader',
  consent: true,
  consentVersion: CONSENT_VERSION,
  jurisdiction: true,
  turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
  ...over,
});
const req = (body: unknown, ip = '203.0.113.7', ct = 'application/json') =>
  new Request('https://site.test/api/join', {
    method: 'POST',
    headers: { 'content-type': ct, 'cf-connecting-ip': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const env = (db: D1Like) => ({ DB: db, TURNSTILE_SECRET: 'test-secret', IP_HASH_SALT: 'pepper' });
const pass = { verify: async () => true, now: () => T0 };

test('normalizeHandle: telegram 5-32, letter first; x 1-15; strips @, URL, case', () => {
  assert.equal(normalizeHandle('@Alice_Trader', 'telegram'), 'tg:alice_trader');
  assert.equal(normalizeHandle('  https://t.me/Alice_Trader/ ', 'telegram'), 'tg:alice_trader');
  assert.equal(normalizeHandle('abcd', 'telegram'), null); // 4 chars
  assert.equal(normalizeHandle('a'.repeat(32), 'telegram'), 'tg:' + 'a'.repeat(32));
  assert.equal(normalizeHandle('a'.repeat(33), 'telegram'), null);
  assert.equal(normalizeHandle('1alice', 'telegram'), null); // must start with a letter
  assert.equal(normalizeHandle('@J', 'x'), 'x:j');
  assert.equal(normalizeHandle('x.com/Some_One', 'x'), 'x:some_one');
  assert.equal(normalizeHandle('a'.repeat(16), 'x'), null);
  assert.equal(normalizeHandle('bad-handle', 'x'), null);
  assert.equal(normalizeHandle('<script>', 'x'), null);
  assert.equal(normalizeHandle('a'.repeat(LIMITS.handleChars + 1), 'telegram'), null);
  assert.equal(normalizeHandle(42, 'x'), null);
});

/** A syntactically valid address of exactly n characters (64-char local part, 60-char domain labels). */
function addressOf(n: number): string {
  const local = 'a'.repeat(64);
  let domain = '.org';
  let left = n - local.length - 1 - domain.length;
  const labels: string[] = [];
  while (left > 0) {
    const k = Math.min(60, labels.length ? left - 1 : left);
    labels.push('b'.repeat(k));
    left -= k + (labels.length > 1 ? 1 : 0);
  }
  domain = labels.join('.') + domain;
  return `${local}@${domain}`;
}

test('normalizeEmail: trims and lowercases, keeps dots and +tags; pragmatic syntax; at most 254 chars', () => {
  assert.equal(normalizeEmail('  Alice.Smith+WL@Example.ORG \n'), 'alice.smith+wl@example.org');
  assert.equal(normalizeEmail('a@b.co'), 'a@b.co');
  assert.equal(normalizeEmail("o'neil_x-1@mail.sub-domain.example.com"), "o'neil_x-1@mail.sub-domain.example.com");
  for (const bad of ['', '   ', 'alice', 'alice@', '@example.org', 'alice@example', 'alice@@example.org', 'a@b@example.org',
    'alice@example.c', 'alice@-example.org', 'alice@example-.org', 'alice@exa_mple.org', '.alice@example.org',
    'alice.@example.org', 'al..ice@example.org', 'al ice@example.org', 'alice@example..org', 'alice@1.2.3.4', '<a>@example.org'])
    assert.equal(normalizeEmail(bad), null, JSON.stringify(bad));
  assert.equal(normalizeEmail(42), null);
  assert.equal(normalizeEmail(null), null);
  const a254 = addressOf(254);
  assert.equal(a254.length, 254);
  assert.equal(normalizeEmail(a254), a254);
  const a255 = addressOf(255);
  assert.equal(a255.length, 255);
  assert.equal(normalizeEmail(a255), null);
  assert.equal(normalizeEmail('a'.repeat(65) + '@example.org'), null);
});

test('optionalHandle: blank is null, valid is the bare lowercase name, invalid is false', () => {
  for (const blank of [undefined, null, '', '   ']) assert.equal(optionalHandle(blank, 'telegram'), null);
  assert.equal(optionalHandle('@Alice_Trader', 'telegram'), 'alice_trader');
  assert.equal(optionalHandle('https://x.com/Some_One', 'x'), 'some_one');
  assert.equal(optionalHandle('abcd', 'telegram'), false);
  assert.equal(optionalHandle('a'.repeat(16), 'x'), false);
});

test('validateSignup: email required; Telegram and X each optional: none / tg only / x only / both / each invalid', () => {
  const base = { email: 'alice@example.org', consentVersion: CONSENT_VERSION, token: 'XXXX.DUMMY.TOKEN.XXXX' };
  const v = (over: Record<string, unknown>) => validateSignup(goodBody({ telegram: undefined, ...over }));
  // none (absent, null or blank)
  for (const over of [{}, { telegram: null, x: null }, { telegram: '  ', x: '' }]) assert.deepEqual(v(over), { ...base, telegram: null, x: null }, JSON.stringify(over));
  // Telegram only, X only, both
  assert.deepEqual(v({ telegram: '@Alice_Trader' }), { ...base, telegram: 'alice_trader', x: null });
  assert.deepEqual(v({ x: '@J' }), { ...base, telegram: null, x: 'j' });
  assert.deepEqual(v({ telegram: 't.me/alice_trader', x: 'x.com/Alice_T' }), { ...base, telegram: 'alice_trader', x: 'alice_t' });
  // each invalid (today's rules), also when the other one is valid
  assert.deepEqual(v({ telegram: 'abcd' }), { error: 'telegram' });
  assert.deepEqual(v({ telegram: '1alice' , x: 'ok' }), { error: 'telegram' });
  assert.deepEqual(v({ x: 'a'.repeat(16) }), { error: 'x' });
  assert.deepEqual(v({ telegram: 'alice_trader', x: 'bad-handle' }), { error: 'x' });
  assert.deepEqual(v({ x: 42 }), { error: 'x' });
  // the old single handle + channel pair is not read any more
  assert.deepEqual(v({ handle: '@bob_trader', channel: 'telegram' }), { ...base, telegram: null, x: null });
  // email still required and normalised
  assert.deepEqual(validateSignup(goodBody({ email: undefined })), { error: 'email' });
  assert.deepEqual(validateSignup(goodBody({ email: 'not-an-email' })), { error: 'email' });
  assert.deepEqual(validateSignup(goodBody({ email: 'ALICE@Example.org ' })), { ...base, telegram: 'alice_trader', x: null });
});

test('validateSignup: names the first failing field', () => {
  assert.deepEqual(validateSignup(goodBody()), {
    email: 'alice@example.org',
    telegram: 'alice_trader',
    x: null,
    consentVersion: CONSENT_VERSION,
    token: 'XXXX.DUMMY.TOKEN.XXXX',
  });
  assert.deepEqual(validateSignup(null), { error: 'body' });
  assert.deepEqual(validateSignup([1]), { error: 'body' });
  assert.deepEqual(validateSignup(goodBody({ telegram: 'no' })), { error: 'telegram' });
  assert.deepEqual(validateSignup(goodBody({ x: 'no-no' })), { error: 'x' });
  assert.deepEqual(validateSignup(goodBody({ consent: 'true' })), { error: 'consent' });
  assert.deepEqual(validateSignup(goodBody({ consentVersion: 'privacy-1999-01-01' })), { error: 'consent' });
  assert.deepEqual(validateSignup(goodBody({ jurisdiction: false })), { error: 'jurisdiction' });
  assert.deepEqual(validateSignup(goodBody({ turnstileToken: '' })), { error: 'captcha' });
  assert.deepEqual(validateSignup(goodBody({ turnstileToken: 'x'.repeat(2049) })), { error: 'captcha' });
});

test('ipHash: salted, stable, 64 hex, differs per salt', async () => {
  const a = await ipHash('203.0.113.7', 's1');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await ipHash('203.0.113.7', 's1'));
  assert.notEqual(a, await ipHash('203.0.113.7', 's2'));
  assert.ok(!a.includes('203'));
});

test('handler: signup inserts one row; a duplicate email returns the same success and adds nothing', async () => {
  const f = fakeD1();
  const r1 = await handleJoin(req(goodBody()), env(f.db), pass);
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { ok: true });
  // the same address in another case, with other whitespace and other handles: still the same person
  const r2 = await handleJoin(req(goodBody({ email: ' Alice@EXAMPLE.org', telegram: 'other_user', x: 'other' })), env(f.db), pass);
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), { ok: true });
  assert.equal(f.waitlist.length, 1);
  assert.deepEqual(f.waitlist[0], {
    email: 'alice@example.org',
    telegram: 'alice_trader',
    x: null,
    consent_version: CONSENT_VERSION,
    jurisdiction_ok: 1,
    created_at: T0 / 1000,
  });
  // a +tag or a dot makes a different address (nothing is stripped)
  await handleJoin(req(goodBody({ email: 'alice+wl@example.org' })), env(f.db), pass);
  await handleJoin(req(goodBody({ email: 'a.lice@example.org', telegram: undefined })), env(f.db), pass);
  await handleJoin(req(goodBody({ email: 'both@example.org', telegram: '@both_handles', x: '@BothX' })), env(f.db), pass);
  assert.equal(f.waitlist.length, 4);
  assert.deepEqual([f.waitlist[3].telegram, f.waitlist[3].x], ['both_handles', 'bothx']);
  // email only: no handles
  assert.deepEqual(f.waitlist[2], {
    email: 'a.lice@example.org',
    telegram: null,
    x: null,
    consent_version: CONSENT_VERSION,
    jurisdiction_ok: 1,
    created_at: T0 / 1000,
  });
  // the raw IP is never written
  assert.ok(f.attempts().every((a) => /^[0-9a-f]{64}$/.test(a.ip_hash)));
});

test('handler: 6th request from one IP within an hour is 429; another IP and the next hour pass', async () => {
  const f = fakeD1();
  for (let i = 0; i < 5; i++) {
    const r = await handleJoin(req(goodBody({ email: `user${i}@example.org`, telegram: `user_number_${i}` })), env(f.db), pass);
    assert.equal(r.status, 200, `request ${i + 1}`);
  }
  const sixth = await handleJoin(req(goodBody({ email: 'user6@example.org', telegram: 'user_number_6' })), env(f.db), pass);
  assert.equal(sixth.status, 429);
  assert.deepEqual(await sixth.json(), { ok: false, error: 'rate' });
  assert.equal(f.waitlist.length, 5);
  assert.equal((await handleJoin(req(goodBody({ email: 'other@example.org' }), '198.51.100.1'), env(f.db), pass)).status, 200);
  const later = { ...pass, now: () => T0 + 3601_000 };
  assert.equal((await handleJoin(req(goodBody({ email: 'user7@example.org' })), env(f.db), later)).status, 200);
  assert.equal(f.waitlist.length, 7);
});

test('handler: invalid requests also count toward the rate limit', async () => {
  const f = fakeD1();
  for (let i = 0; i < 5; i++) assert.equal((await handleJoin(req(goodBody({ telegram: '!' })), env(f.db), pass)).status, 400);
  assert.equal((await handleJoin(req(goodBody()), env(f.db), pass)).status, 429);
});

test('handler: attempt rows older than 24 h are deleted', async () => {
  const f = fakeD1();
  await handleJoin(req(goodBody()), env(f.db), pass);
  assert.equal(f.attempts().length, 1);
  await handleJoin(req(goodBody()), env(f.db), { ...pass, now: () => T0 + 86_401_000 });
  assert.equal(f.attempts().length, 1);
});

test('handler: Turnstile failure is 403 and stores nothing; verify gets token, secret and IP', async () => {
  const f = fakeD1();
  const seen: unknown[] = [];
  const r = await handleJoin(req(goodBody()), env(f.db), {
    verify: async (...a) => (seen.push(a), false),
    now: () => T0,
  });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { ok: false, error: 'captcha' });
  assert.deepEqual(seen, [['XXXX.DUMMY.TOKEN.XXXX', 'test-secret', '203.0.113.7']]);
  assert.equal(f.waitlist.length, 0);
});

test('handler: bad input is 400 before Turnstile is called', async () => {
  const f = fakeD1();
  let called = 0;
  const deps = { verify: async () => (called++, true), now: () => T0 };
  for (const [body, error] of [
    [goodBody({ email: 'nope' }), 'email'],
    [goodBody({ email: 'b@example.org', telegram: 'x' }), 'telegram'],
    [goodBody({ email: 'c@example.org', x: 'bad-handle' }), 'x'],
    [goodBody({ consent: false }), 'consent'],
    [goodBody({ jurisdiction: undefined }), 'jurisdiction'],
    ['{not json', 'body'],
  ] as const) {
    const r = await handleJoin(req(body, `192.0.2.${called + Math.random()}`), env(f.db), deps);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { ok: false, error });
  }
  assert.equal(called, 0);
  assert.equal(f.waitlist.length, 0);
});

test('handler: non-JSON content type 415, oversize body 413, missing config 500, DB error 500', async () => {
  const f = fakeD1();
  assert.equal((await handleJoin(req('handle=a', undefined, 'application/x-www-form-urlencoded'), env(f.db), pass)).status, 415);
  assert.equal((await handleJoin(req(goodBody({ pad: 'x'.repeat(LIMITS.bodyBytes) })), env(f.db), pass)).status, 413);
  assert.equal((await handleJoin(req(goodBody()), { DB: f.db, TURNSTILE_SECRET: '', IP_HASH_SALT: 's' }, pass)).status, 500);
  assert.equal((await handleJoin(req(goodBody()), { TURNSTILE_SECRET: 't', IP_HASH_SALT: 's' }, pass)).status, 500);
  const broken = fakeD1({ failOn: /INSERT INTO waitlist/ });
  const r = await handleJoin(req(goodBody()), env(broken.db), pass);
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { ok: false, error: 'db' });
});

test('turnstileVerifier: posts secret/response/remoteip to siteverify; only success:true passes', async () => {
  const calls: { url: string; body: FormData }[] = [];
  const mk = (res: unknown, ok = true) =>
    turnstileVerifier((async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as FormData });
      return new Response(JSON.stringify(res), { status: ok ? 200 : 500 });
    }) as unknown as typeof fetch);
  assert.equal(await mk({ success: true })('tok', 'sec', '1.2.3.4'), true);
  assert.equal(calls[0].url, SITEVERIFY_URL);
  assert.equal(calls[0].body.get('secret'), 'sec');
  assert.equal(calls[0].body.get('response'), 'tok');
  assert.equal(calls[0].body.get('remoteip'), '1.2.3.4');
  assert.equal(await mk({ success: false })('tok', 'sec', ''), false);
  assert.equal(await mk({ success: 'true' })('tok', 'sec', ''), false);
  assert.equal(await mk({ success: true }, false)('tok', 'sec', ''), false);
  const throwing = turnstileVerifier((async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch);
  assert.equal(await throwing('tok', 'sec', ''), false);
});

test('consent: the current version and all earlier versions are accepted; anything else is refused', () => {
  assert.deepEqual([...CONSENT_VERSIONS], [CONSENT_VERSION, 'privacy-2026-10-03-v4', 'privacy-2026-10-03-v3', 'privacy-2026-10-03-v2', 'privacy-2026-10-03', 'privacy-2026-10-02-v2', 'privacy-2026-10-02']);
  for (const v of CONSENT_VERSIONS) assert.ok(!('error' in validateSignup(goodBody({ consentVersion: v }))), v);
  assert.deepEqual(validateSignup(goodBody({ consentVersion: 'privacy-2026-10-04' })), { error: 'consent' });
});

// ---- region soft block (Cloudflare's cf-ipcountry) ----
const reqFrom = (country: string | null, body: unknown = goodBody(), ip = '203.0.113.7') => {
  const r = req(body, ip);
  if (country !== null) r.headers.set('cf-ipcountry', country);
  return r;
};

test('region: the blocked list is the US, the UK and the comprehensively sanctioned countries', () => {
  assert.deepEqual([...BLOCKED_REGIONS].sort(), ['CU', 'GB', 'IR', 'KP', 'SY', 'US']);
});

test('region: each blocked country is 403 {error:"region"}, stores nothing and does not even count as an attempt', async () => {
  for (const c of BLOCKED_REGIONS) {
    const f = fakeD1();
    let verified = 0;
    const r = await handleJoin(reqFrom(c), env(f.db), { verify: async () => (verified++, true), now: () => T0 });
    assert.equal(r.status, 403, c);
    assert.deepEqual(await r.json(), { ok: false, error: 'region' }, c);
    assert.equal(f.waitlist.length, 0, c);
    assert.equal(f.attempts().length, 0, c);
    assert.equal(verified, 0, c);
  }
});

test('region: lower-case codes are read too; an invalid body from a blocked country is still region', async () => {
  const f = fakeD1();
  assert.deepEqual(await (await handleJoin(reqFrom('gb'), env(f.db), pass)).json(), { ok: false, error: 'region' });
  assert.deepEqual(await (await handleJoin(reqFrom('US', '{not json'), env(f.db), pass)).json(), { ok: false, error: 'region' });
});

test('region: an allowed country (TR, DE, CA), Tor (T1), unknown (XX) and no header at all go through to the checkbox rules', async () => {
  for (const c of ['TR', 'DE', 'CA', 'T1', 'XX', 'xx', '', 'garbage', null]) {
    const f = fakeD1();
    const r = await handleJoin(reqFrom(c), env(f.db), pass);
    assert.equal(r.status, 200, String(c));
    assert.equal(f.waitlist.length, 1, String(c));
  }
  // not a blanket pass: the jurisdiction checkbox still decides
  const f = fakeD1();
  const r = await handleJoin(reqFrom('T1', goodBody({ jurisdiction: false })), env(f.db), pass);
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { ok: false, error: 'jurisdiction' });
});

test('region: requestCountry prefers the header, falls back to request.cf.country, ignores anything but two letters', () => {
  assert.equal(requestCountry(reqFrom('tr')), 'TR');
  assert.equal(requestCountry(reqFrom(null)), '');
  const withCf = (country: string) => Object.assign(reqFrom(null), { cf: { country } });
  assert.equal(requestCountry(withCf('GB')), 'GB');
  assert.equal(regionBlocked(withCf('GB')), true);
  assert.equal(requestCountry(Object.assign(reqFrom('TR'), { cf: { country: 'GB' } })), 'TR');
  assert.equal(requestCountry(reqFrom('T1x')), '');
});
