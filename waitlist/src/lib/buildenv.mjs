// Copied unchanged from site/src/lib/buildenv.mjs (waitlist v2 build, 2026-10-02).
// Build-time settings of the site, read from the environment (never from a committed file).
// Used by astro.config.mjs (fails a production build), by the pages (fills the placeholders) and by
// scripts/deploy-site.mjs (checks before it builds).
//
//   SITE_ENV=production      production build: every check below must pass or the build fails
//   SITE_CONTROLLER_NAME     controller identity on /privacy            -> {{CONTROLLER_NAME}}
//   SITE_DELETE_BY           waitlist deletion date, YYYY-MM-DD         -> {{DELETE_BY}}
//   SITE_LEGAL_REVIEWED=1    hides the "Pending legal review" note
//   PUBLIC_TURNSTILE_SITEKEY Turnstile site key (public by design); dev builds fall back to the always-pass test key

/** Cloudflare's published always-pass Turnstile TEST site key (dev and local only). */
export const TURNSTILE_TEST_SITEKEY = '1x00000000000000000000AA';

const trim = (v) => (typeof v === 'string' ? v.trim() : '');

/** -> { production, controllerName, deleteBy, legalReviewed, turnstileSitekey, problems: string[] } */
export function readBuildEnv(env = process.env) {
  const production = trim(env.SITE_ENV) === 'production';
  const controllerName = trim(env.SITE_CONTROLLER_NAME);
  const deleteBy = trim(env.SITE_DELETE_BY);
  const legalReviewed = trim(env.SITE_LEGAL_REVIEWED) === '1';
  const sitekey = trim(env.PUBLIC_TURNSTILE_SITEKEY);
  const problems = [];
  if (!controllerName) problems.push('SITE_CONTROLLER_NAME is empty ({{CONTROLLER_NAME}} on /privacy)');
  if (!deleteBy) problems.push('SITE_DELETE_BY is empty ({{DELETE_BY}} on /privacy)');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(deleteBy) || Number.isNaN(Date.parse(`${deleteBy}T00:00:00Z`)))
    problems.push(`SITE_DELETE_BY must be a date YYYY-MM-DD (got "${deleteBy}")`);
  if (!sitekey) problems.push('PUBLIC_TURNSTILE_SITEKEY is empty');
  else if (production && /^[123]x0{20}/.test(sitekey))
    problems.push('PUBLIC_TURNSTILE_SITEKEY is a Cloudflare test key; production needs the real site key');
  return {
    production,
    controllerName,
    deleteBy,
    legalReviewed,
    turnstileSitekey: sitekey || TURNSTILE_TEST_SITEKEY,
    problems,
  };
}

/** Throws in production when anything is missing; returns the settings otherwise. */
export function assertBuildEnv(env = process.env) {
  const b = readBuildEnv(env);
  if (b.production && b.problems.length)
    throw new Error(`site production build refused:\n  - ${b.problems.join('\n  - ')}`);
  return b;
}

/** Replaces {{CONTROLLER_NAME}} / {{DELETE_BY}}; an empty value leaves the placeholder visible (dev). */
export function fillPlaceholders(text, b) {
  return text
    .replaceAll('{{CONTROLLER_NAME}}', b.controllerName || '{{CONTROLLER_NAME}}')
    .replaceAll('{{DELETE_BY}}', b.deleteBy || '{{DELETE_BY}}');
}
