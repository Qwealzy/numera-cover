// Plan for scripts/deploy-site.mjs (pure, tested in deploysite.test.mjs). Nothing here runs a command.
import { readBuildEnv } from '../../site/src/lib/buildenv.mjs';

export const PROJECT = 'numera-cover';
export const DB_NAME = 'numera-waitlist';
export const PLACEHOLDER_DB_ID = '00000000-0000-0000-0000-000000000000';
export const REQUIRED_SECRETS = ['TURNSTILE_SECRET', 'IP_HASH_SALT'];

export const USAGE = `node scripts/deploy-site.mjs [--prod] [--create-project] [--yes]
  default           preview deploy (branch "preview" -> https://preview.${PROJECT}.pages.dev)
  --prod            production deploy (branch "main" -> https://${PROJECT}.pages.dev)
  --create-project  first run only: create the Pages project (production branch main)
  --yes             execute; without it the script prints the plan and exits
Needs: \`npx wrangler login\` once, and in the shell environment SITE_CONTROLLER_NAME, SITE_DELETE_BY (YYYY-MM-DD),
PUBLIC_TURNSTILE_SITEKEY; optional SITE_LEGAL_REVIEWED=1. Pages secrets ${REQUIRED_SECRETS.join(', ')} must be set
(npx wrangler pages secret put <NAME> --project-name ${PROJECT}).`;

export function parseArgs(argv) {
  const known = new Set(['--prod', '--create-project', '--yes', '--help', '-h']);
  const unknown = argv.filter((a) => !known.has(a));
  return {
    prod: argv.includes('--prod'),
    createProject: argv.includes('--create-project'),
    yes: argv.includes('--yes'),
    help: argv.includes('--help') || argv.includes('-h'),
    unknown,
  };
}

/** database_id of the DB binding in site/wrangler.toml, or null. */
export function d1DatabaseId(toml) {
  const m = toml.match(/database_name\s*=\s*"numera-waitlist"[\s\S]*?database_id\s*=\s*"([^"]*)"/);
  return m ? m[1] : null;
}

/** -> { problems: string[], steps: { name, cmd: string[], env?: object }[], branch } */
export function deployPlan(args, env, wranglerToml) {
  const b = readBuildEnv({ ...env, SITE_ENV: 'production' });
  const problems = [...b.problems];
  if (args.unknown.length) problems.push(`unknown argument(s): ${args.unknown.join(' ')}`);
  const dbId = d1DatabaseId(wranglerToml);
  if (!dbId || dbId === PLACEHOLDER_DB_ID)
    problems.push(`site/wrangler.toml database_id is the placeholder: run \`npx wrangler d1 create ${DB_NAME}\` and paste the id`);
  const branch = args.prod ? 'main' : 'preview';
  const buildEnv = {
    SITE_ENV: 'production',
    SITE_CONTROLLER_NAME: b.controllerName,
    SITE_DELETE_BY: b.deleteBy,
    PUBLIC_TURNSTILE_SITEKEY: env.PUBLIC_TURNSTILE_SITEKEY ?? '',
    SITE_LEGAL_REVIEWED: b.legalReviewed ? '1' : '',
  };
  const steps = [];
  if (args.createProject)
    steps.push({ name: 'create Pages project', cmd: ['wrangler', 'pages', 'project', 'create', PROJECT, '--production-branch', 'main'] });
  steps.push(
    { name: 'check Pages secrets exist', cmd: ['wrangler', 'pages', 'secret', 'list', '--project-name', PROJECT], expect: REQUIRED_SECRETS },
    { name: 'build (production)', cmd: ['astro', 'build'], env: buildEnv },
    { name: 'apply D1 migrations (remote)', cmd: ['wrangler', 'd1', 'migrations', 'apply', DB_NAME, '--remote'] },
    { name: `deploy dist (branch ${branch})`, cmd: ['wrangler', 'pages', 'deploy', 'dist', '--project-name', PROJECT, '--branch', branch] },
  );
  return { problems, steps, branch };
}
