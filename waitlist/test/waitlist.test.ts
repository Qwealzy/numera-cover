// Copied unchanged from site/test/waitlist.test.ts (waitlist v2 build, 2026-10-02): the same contract must pass here.
// node --test: validation, normalisation and the /api/join handler with a fake D1 and a fake Turnstile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHandle,
  validateSignup,
  handleJoin,
  ipHash,
  turnstileVerifier,
  SITEVERIFY_URL,
  LIMITS,
  type D1Like,
  type D1Stmt,
} from '../src/server/waitlist.ts';
import { CONSENT_VERSION } from '../src/copy/en.ts';

// ---- fake D1: implements exactly the statements the handler issues ----
type Row = { handle_norm: string; channel: string; consent_version: string; jurisdiction_ok: number; created_at: number };
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
            assert.match(sql, /ON CONFLICT\(handle_norm\) DO NOTHING/);
            const [handle_norm, channel, consent_version, created_at] = args as [string, string, string, number];
            if (!waitlist.some((r) => r.handle_norm === handle_norm))
              waitlist.push({ handle_norm, channel, consent_version, jurisdiction_ok: 1, created_at });
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
  handle: '@Alice_Trader',
  channel: 'telegram',
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

test('validateSignup: names the first failing field', () => {
  assert.deepEqual(validateSignup(goodBody()), {
    handleNorm: 'tg:alice_trader',
    channel: 'telegram',
    consentVersion: CONSENT_VERSION,
    token: 'XXXX.DUMMY.TOKEN.XXXX',
  });
  assert.deepEqual(validateSignup(null), { error: 'body' });
  assert.deepEqual(validateSignup([1]), { error: 'body' });
  assert.deepEqual(validateSignup(goodBody({ channel: 'email' })), { error: 'channel' });
  assert.deepEqual(validateSignup(goodBody({ handle: 'no' })), { error: 'handle' });
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

test('handler: signup inserts one row; duplicate returns the same success and adds nothing', async () => {
  const f = fakeD1();
  const r1 = await handleJoin(req(goodBody()), env(f.db), pass);
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { ok: true });
  const r2 = await handleJoin(req(goodBody({ handle: 'alice_trader' })), env(f.db), pass);
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), { ok: true });
  assert.equal(f.waitlist.length, 1);
  assert.deepEqual(f.waitlist[0], {
    handle_norm: 'tg:alice_trader',
    channel: 'telegram',
    consent_version: CONSENT_VERSION,
    jurisdiction_ok: 1,
    created_at: T0 / 1000,
  });
  // same name on X is a different person
  await handleJoin(req(goodBody({ channel: 'x' })), env(f.db), pass);
  assert.equal(f.waitlist.length, 2);
  // the raw IP is never written
  assert.ok(f.attempts().every((a) => /^[0-9a-f]{64}$/.test(a.ip_hash)));
});

test('handler: 6th request from one IP within an hour is 429; another IP and the next hour pass', async () => {
  const f = fakeD1();
  for (let i = 0; i < 5; i++) {
    const r = await handleJoin(req(goodBody({ handle: `user_number_${i}` })), env(f.db), pass);
    assert.equal(r.status, 200, `request ${i + 1}`);
  }
  const sixth = await handleJoin(req(goodBody({ handle: 'user_number_6' })), env(f.db), pass);
  assert.equal(sixth.status, 429);
  assert.deepEqual(await sixth.json(), { ok: false, error: 'rate' });
  assert.equal(f.waitlist.length, 5);
  assert.equal((await handleJoin(req(goodBody({ handle: 'other_ip_user' }), '198.51.100.1'), env(f.db), pass)).status, 200);
  const later = { ...pass, now: () => T0 + 3601_000 };
  assert.equal((await handleJoin(req(goodBody({ handle: 'user_number_7' })), env(f.db), later)).status, 200);
});

test('handler: invalid requests also count toward the rate limit', async () => {
  const f = fakeD1();
  for (let i = 0; i < 5; i++) assert.equal((await handleJoin(req(goodBody({ handle: '!' })), env(f.db), pass)).status, 400);
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
    [goodBody({ handle: 'x' }), 'handle'],
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
