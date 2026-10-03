// Plan for scripts/deploy-site.mjs (pure, tested in deploysite.test.mjs). Nothing here runs a command.
// The deployed site is waitlist/ (founder decision 2026-10-03, option b); site/ stays in the repo, undeployed.
import { readBuildEnv } from '../../waitlist/src/lib/buildenv.mjs';

/** The directory that is built and deployed, relative to the repo root. */
export const SITE_DIR = 'waitlist';
/** D1 migrations the deployed handler needs, in order (waitlist/migrations/). 0002 makes email the unique key. */
export const MIGRATIONS = ['0001_waitlist.sql', '0002_email.sql'];

export const PROJECT = 'numera-cover';
export const DB_NAME = 'numera-waitlist';
/** The only D1 jurisdiction the privacy notice allows (a D1 database's jurisdiction is fixed at creation). */
export const D1_JURISDICTION = 'eu';
export const PLACEHOLDER_DB_ID = '00000000-0000-0000-0000-000000000000';
export const REQUIRED_SECRETS = ['TURNSTILE_SECRET', 'IP_HASH_SALT'];

export const USAGE = `node scripts/deploy-site.mjs [--prod] [--create-project] [--create-db] [--accept-unverified-jurisdiction] [--yes]
  default           preview deploy (branch "preview" -> https://preview.${PROJECT}.pages.dev)
  --prod            production deploy (branch "main" -> https://${PROJECT}.pages.dev)
  --create-project  first run only: create the Pages project (production branch main)
  --create-db       first run only: create the D1 database ${DB_NAME} in the ${D1_JURISDICTION} jurisdiction (wrangler d1 create --jurisdiction ${D1_JURISDICTION}),
                    nothing else; paste the printed database_id into ${SITE_DIR}/wrangler.toml, then run again without it
  --accept-unverified-jurisdiction
                    only when wrangler cannot say where the existing database lives: proceed after reading the warning
  --yes             execute; without it the script prints the plan and exits
Before anything is built or deployed the plan checks that the existing database is in the ${D1_JURISDICTION} jurisdiction (the privacy
notice says the waitlist is stored in the EU): another jurisdiction stops the run; a database whose jurisdiction wrangler does
not report stops it too, unless --accept-unverified-jurisdiction is given.
Builds and deploys ${SITE_DIR}/ and applies its D1 migrations (${MIGRATIONS.join(', ')}) to the remote database
${DB_NAME}. 0002 is not compatible with site/'s handler: never point site/ at the same database afterwards.
Needs: \`npx wrangler login\` once, and in the shell environment SITE_CONTROLLER_NAME, SITE_DELETE_BY (YYYY-MM-DD),
SITE_GOVERNING_LAW (the law of the terms of use), SITE_SOURCE_URL (the PUBLIC repository, footer link),
PUBLIC_TURNSTILE_SITEKEY; optional SITE_LEGAL_REVIEWED=1. Pages secrets ${REQUIRED_SECRETS.join(', ')} must be set
(npx wrangler pages secret put <NAME> --project-name ${PROJECT}).`;

export function parseArgs(argv) {
  const known = new Set(['--prod', '--create-project', '--create-db', '--accept-unverified-jurisdiction', '--yes', '--help', '-h']);
  const unknown = argv.filter((a) => !known.has(a));
  return {
    prod: argv.includes('--prod'),
    createProject: argv.includes('--create-project'),
    createDb: argv.includes('--create-db'),
    acceptUnverified: argv.includes('--accept-unverified-jurisdiction'),
    yes: argv.includes('--yes'),
    help: argv.includes('--help') || argv.includes('-h'),
    unknown,
  };
}

/** "host/owner/repo" of a git remote or web URL: lower case, no scheme, credentials, .git or trailing slash. */
export function repoKey(url) {
  return String(url)
    .trim()
    .toLowerCase()
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]*@/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

/** Judges the stdout of wrangler d1 info <db> --json. -> { verdict: 'ok' | 'refuse' | 'unknown', jurisdiction, message }.
 *  ok = reported and eu; refuse = reported and anything else; unknown = not reported or not parseable
 *  (the caller then needs --accept-unverified-jurisdiction). */
export function judgeJurisdiction(stdout) {
  const text = String(stdout ?? '');
  let info = null;
  const a = text.indexOf('{');
  const z = text.lastIndexOf('}');
  if (a >= 0 && z > a) {
    try {
      info = JSON.parse(text.slice(a, z + 1));
    } catch {
      info = null;
    }
  }
  const raw = info && typeof info === 'object' ? (info.jurisdiction ?? info.result?.jurisdiction) : undefined;
  const j = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (j === D1_JURISDICTION) return { verdict: 'ok', jurisdiction: j, message: `${DB_NAME} is in the ${D1_JURISDICTION} jurisdiction` };
  if (j)
    return {
      verdict: 'refuse',
      jurisdiction: j,
      message: `${DB_NAME} is in the "${j}" jurisdiction, not "${D1_JURISDICTION}". A D1 jurisdiction cannot be changed: create a new database with wrangler d1 create <name> --jurisdiction ${D1_JURISDICTION} and move the data; the privacy notice says the waitlist is stored in the EU.`,
    };
  return {
    verdict: 'unknown',
    jurisdiction: '',
    message: `WARNING: wrangler did not report the jurisdiction of ${DB_NAME} (wrangler d1 info ${DB_NAME} --json). If it was not created with --jurisdiction ${D1_JURISDICTION}, the privacy notice is wrong. Check it in the Cloudflare dashboard (D1 > ${DB_NAME}), then re-run with --accept-unverified-jurisdiction.`,
  };
}

/** database_id of the DB binding in waitlist/wrangler.toml, or null. */
export function d1DatabaseId(toml) {
  const m = toml.match(/database_name\s*=\s*"numera-waitlist"[\s\S]*?database_id\s*=\s*"([^"]*)"/);
  return m ? m[1] : null;
}

/** `migrationFiles`: the file names in waitlist/migrations/ (every one in MIGRATIONS must be there).
 *  -> { problems: string[], steps: { name, cmd: string[], env?: object }[], branch } */
export function deployPlan(args, env, wranglerToml, migrationFiles = MIGRATIONS, originUrl = '') {
  const b = readBuildEnv({ ...env, SITE_ENV: 'production' });
  if (args.createDb)
    return {
      problems: args.unknown.length ? [`unknown argument(s): ${args.unknown.join(' ')}`] : [],
      steps: [{ name: `create D1 database ${DB_NAME} (${D1_JURISDICTION} jurisdiction)`, cmd: ['wrangler', 'd1', 'create', DB_NAME, '--jurisdiction', D1_JURISDICTION] }],
      branch: null,
    };
  const problems = [...b.problems];
  // the footer "Source" link must never be the private origin repository (compared as host/owner/repo)
  if (b.sourceUrl && originUrl && repoKey(b.sourceUrl) === repoKey(originUrl))
    problems.push('SITE_SOURCE_URL is the private origin repository; use the PUBLIC repository (made by scripts/export-public.mjs)');
  if (args.unknown.length) problems.push(`unknown argument(s): ${args.unknown.join(' ')}`);
  const dbId = d1DatabaseId(wranglerToml);
  if (!dbId || dbId === PLACEHOLDER_DB_ID)
    problems.push(`${SITE_DIR}/wrangler.toml database_id is the placeholder: run node scripts/deploy-site.mjs --create-db --yes (wrangler d1 create ${DB_NAME} --jurisdiction ${D1_JURISDICTION}) and paste the id`);
  if (!/migrations_dir\s*=\s*"migrations"/.test(wranglerToml)) problems.push(`${SITE_DIR}/wrangler.toml has no migrations_dir = "migrations"`);
  for (const m of MIGRATIONS) if (!migrationFiles.includes(m)) problems.push(`${SITE_DIR}/migrations/${m} is missing`);
  const branch = args.prod ? 'main' : 'preview';
  const buildEnv = {
    SITE_ENV: 'production',
    SITE_CONTROLLER_NAME: b.controllerName,
    SITE_DELETE_BY: b.deleteBy,
    SITE_GOVERNING_LAW: b.governingLaw,
    SITE_SOURCE_URL: b.sourceUrl,
    PUBLIC_TURNSTILE_SITEKEY: env.PUBLIC_TURNSTILE_SITEKEY ?? '',
    SITE_LEGAL_REVIEWED: b.legalReviewed ? '1' : '',
  };
  const steps = [];
  if (args.createProject)
    steps.push({ name: 'create Pages project', cmd: ['wrangler', 'pages', 'project', 'create', PROJECT, '--production-branch', 'main'] });
  steps.push(
    { name: 'check Pages secrets exist', cmd: ['wrangler', 'pages', 'secret', 'list', '--project-name', PROJECT], expect: REQUIRED_SECRETS },
    {
      name: `check the D1 database is in the ${D1_JURISDICTION} jurisdiction`,
      cmd: ['wrangler', 'd1', 'info', DB_NAME, '--json'],
      jurisdiction: { acceptUnverified: args.acceptUnverified },
    },
    { name: 'build (production)', cmd: ['astro', 'build'], env: buildEnv },
    { name: `apply D1 migrations ${MIGRATIONS.map((m) => m.slice(0, 4)).join('+')} (remote)`, cmd: ['wrangler', 'd1', 'migrations', 'apply', DB_NAME, '--remote'] },
    { name: `deploy dist (branch ${branch})`, cmd: ['wrangler', 'pages', 'deploy', 'dist', '--project-name', PROJECT, '--branch', branch] },
  );
  return { problems, steps, branch };
}
