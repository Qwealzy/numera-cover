// node --test: migrations 0001 + 0002 on a fresh SQLite database (node:sqlite; D1 is SQLite), then the real
// /api/join handler against it through a small D1 adapter, so the SQL itself is exercised: rows from 0001 survive
// 0002, signups with both handles and with email only land, a duplicate email adds nothing, the 6th request is 429.
// `wrangler d1 migrations apply --local` is the deploy-side check (README); this one runs in every npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleJoin, type D1Like, type D1Stmt } from '../src/server/waitlist.ts';
import { CONSENT_VERSION } from '../src/copy/en.ts';

const mig = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');

function d1(db: DatabaseSync): D1Like {
  return {
    prepare(sql: string): D1Stmt {
      let args: unknown[] = [];
      const stmt: D1Stmt = {
        bind(...v: unknown[]) {
          args = v;
          return stmt;
        },
        async run() {
          return db.prepare(sql).run(...(args as never[]));
        },
        async first<T>() {
          return (db.prepare(sql).get(...(args as never[])) ?? null) as T | null;
        },
      };
      return stmt;
    },
  };
}

const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
const deps = { verify: async () => true, now: () => T0 };
const env = (db: DatabaseSync) => ({ DB: d1(db), TURNSTILE_SECRET: 'test-secret', IP_HASH_SALT: 'pepper' });
const post = (body: Record<string, unknown>, ip = '203.0.113.9') =>
  new Request('https://site.test/api/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ consent: true, consentVersion: CONSENT_VERSION, jurisdiction: true, turnstileToken: 'tok', ...body }),
  });

test('0001 then 0002 on a fresh database: old rows kept (no email), new constraints in force', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(mig('0001_waitlist.sql'));
  db.prepare('INSERT INTO waitlist (handle_norm, channel, consent_version, jurisdiction_ok, created_at) VALUES (?, ?, ?, 1, ?)').run(
    'tg:old_user',
    'telegram',
    'privacy-2026-10-02',
    1,
  );
  db.exec(mig('0002_email.sql'));
  assert.deepEqual(
    { ...(db.prepare('SELECT email, handle_norm, channel, consent_version FROM waitlist').get() as object) },
    { email: null, handle_norm: 'tg:old_user', channel: 'telegram', consent_version: 'privacy-2026-10-02' },
  );
  const ins = db.prepare('INSERT INTO waitlist (email, telegram, x, consent_version, jurisdiction_ok, created_at) VALUES (?, ?, ?, ?, ?, 1)');
  // no email and no legacy handle; a too-short Telegram name; a too-long X handle; jurisdiction not confirmed
  assert.throws(() => ins.run(null, 'alice_trader', null, 'v', 1), /CHECK/);
  assert.throws(() => ins.run('a@b.co', 'abcd', null, 'v', 1), /CHECK/);
  assert.throws(() => ins.run('a@b.co', null, 'a'.repeat(16), 'v', 1), /CHECK/);
  assert.throws(() => ins.run('a@b.co', null, null, 'v', 0), /CHECK/);
  ins.run('a@b.co', null, null, 'v', 1);
  assert.throws(() => ins.run('a@b.co', null, 'other', 'v', 1), /UNIQUE/);
  // both handles on one row; the same handles with another email are a separate signup (handles are not unique)
  ins.run('c@d.co', 'alice_trader', 'alice', 'v', 1);
  ins.run('e@f.co', 'alice_trader', 'alice', 'v', 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM waitlist').get() as { n: number }).n, 4);
});

test('handler on the migrated schema: email + handle, email only, duplicate email, 429 on the 6th', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(mig('0001_waitlist.sql'));
  db.exec(mig('0002_email.sql'));
  const e = env(db);
  const rows = () => db.prepare('SELECT email, telegram, x FROM waitlist ORDER BY rowid').all().map((r) => ({ ...r }));

  assert.equal((await handleJoin(post({ email: 'Alice@Example.org', telegram: '@alice_trader', x: '@Alice_X' }), e, deps)).status, 200);
  assert.equal((await handleJoin(post({ email: 'bob+wl@example.org' }), e, deps)).status, 200);
  const dup = await handleJoin(post({ email: ' ALICE@example.ORG ', x: 'someone' }), e, deps);
  assert.equal(dup.status, 200);
  assert.deepEqual(await dup.json(), { ok: true });
  assert.deepEqual(rows(), [
    { email: 'alice@example.org', telegram: 'alice_trader', x: 'alice_x' },
    { email: 'bob+wl@example.org', telegram: null, x: null },
  ]);
  assert.equal((await handleJoin(post({ email: 'carol@example.org' }), e, deps)).status, 200);
  assert.equal((await handleJoin(post({ email: 'dave@example.org' }), e, deps)).status, 200);
  const sixth = await handleJoin(post({ email: 'erin@example.org' }), e, deps);
  assert.equal(sixth.status, 429);
  assert.equal(rows().length, 4);
});
