// Plan for scripts/deploy-app.mjs (pure, tested in deployapp.test.mjs). Nothing here runs a command.
// The deployed app is app/ (Vite), as its own Cloudflare Pages project, served at https://app.numeralabs.xyz (D31:
// unlisted judge-only address, noindex, not linked from the site or the README).

export const APP_DIR = 'app';
export const PROJECT = 'numera-app';
export const APP_ORIGIN = 'https://app.numeralabs.xyz';
export const DEFAULT_ENGINE_URL = 'https://api.numeralabs.xyz';
/** wrangler is pinned (same version as waitlist/package.json) and fetched on demand: app/ does not depend on it. */
export const WRANGLER = 'wrangler@4.147.0';

export const USAGE = `node scripts/deploy-app.mjs [--prod] [--create-project] [--yes]
  default           preview deploy (branch "preview" -> https://preview.${PROJECT}.pages.dev)
  --prod            production deploy (branch "main"; attach ${APP_ORIGIN} to the project in the Cloudflare dashboard once)
  --create-project  first run only: create the Pages project ${PROJECT} (production branch main) and nothing else
  --yes             execute; without it the script prints the plan and exits
Builds app/ for production with VITE_ENGINE_URL (default ${DEFAULT_ENGINE_URL}; the shell may override it with another https URL),
then runs wrangler pages deploy dist. Needs "npx wrangler login" once. Reads no .env file and prints no secret: the app holds none
(public RPC and the engine URL only). app/public/_headers sends X-Robots-Tag: noindex, nofollow; index.html has the robots meta tag.
Testnet only: the app has no chain 999 anywhere.`;

export function parseArgs(argv) {
  const known = new Set(['--prod', '--create-project', '--yes', '--help', '-h']);
  return {
    prod: argv.includes('--prod'),
    createProject: argv.includes('--create-project'),
    yes: argv.includes('--yes'),
    help: argv.includes('--help') || argv.includes('-h'),
    unknown: argv.filter((a) => !known.has(a)),
  };
}

/** Validates the engine URL for a PUBLIC build. -> { url, problem } (url normalised, no trailing slash). */
export function engineUrl(raw) {
  const v = String(raw ?? '').trim() || DEFAULT_ENGINE_URL;
  let u;
  try {
    u = new URL(v);
  } catch {
    return { url: v, problem: `VITE_ENGINE_URL is not a URL: ${v}` };
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|.*\.localhost|.*\.test)$/i.test(u.hostname);
  if (u.protocol !== 'https:' || local)
    return { url: v, problem: `VITE_ENGINE_URL must be a public https URL for a deployed app (got ${v}); a page on https cannot call http or localhost` };
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== ''))
    return { url: v, problem: `VITE_ENGINE_URL must be a bare origin without credentials, path or query (got ${v})` };
  return { url: u.origin, problem: null };
}

/** `envFiles`: names of the app/.env* files that exist (shell values win in Vite, but other values there leak in).
 *  -> { problems: string[], warnings: string[], steps: { name, cmd: string[], env?: object }[], branch, setupOnly } */
export function deployPlan(args, env = {}, envFiles = []) {
  const problems = args.unknown.length ? [`unknown argument(s): ${args.unknown.join(' ')}`] : [];
  if (args.createProject)
    return {
      problems,
      warnings: [],
      steps: [{ name: 'create Pages project', cmd: ['npx', '--yes', WRANGLER, 'pages', 'project', 'create', PROJECT, '--production-branch', 'main'] }],
      branch: null,
      setupOnly: true,
    };
  const warnings = [];
  const e = engineUrl(env.VITE_ENGINE_URL);
  if (e.problem) problems.push(e.problem);
  if (['1', 'true'].includes(String(env.VITE_USE_QUOTE_FIXTURE ?? '').trim())) problems.push('VITE_USE_QUOTE_FIXTURE is on: a deployed app must call the real engine');
  const rpc = String(env.VITE_RPC_URL ?? '').trim();
  if (rpc && !/^https:\/\//i.test(rpc)) problems.push(`VITE_RPC_URL must be https for a deployed app (got ${rpc})`);
  if (envFiles.length) warnings.push(`app/${envFiles.join(', app/')} exist: values there that this plan does not set (RPC, explorer, waitlist URL) go into the public build`);
  const branch = args.prod ? 'main' : 'preview';
  // The engine URL is set for all three names the app reads, so an app/.env.local cannot point one pool elsewhere.
  const buildEnv = {
    VITE_ENGINE_URL: e.url,
    VITE_ENGINE_URL_MOCK: e.url,
    VITE_ENGINE_URL_HYPERCORE: e.url,
    VITE_USE_QUOTE_FIXTURE: '0',
  };
  const steps = [
    { name: `build app/ (production, engine ${e.url})`, cmd: ['npm', 'run', 'build'], env: buildEnv },
    { name: `deploy dist (branch ${branch})`, cmd: ['npx', '--yes', WRANGLER, 'pages', 'deploy', 'dist', '--project-name', PROJECT, '--branch', branch] },
  ];
  return { problems, warnings, steps, branch, setupOnly: false };
}
