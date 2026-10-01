// Minimal .env handling without dependencies. Values are never printed by callers; only names and a status.
import { existsSync, readFileSync } from 'node:fs';

// KEY=VALUE per line; '#' comments and blank lines ignored; optional `export ` prefix; surrounding single or
// double quotes stripped; an unquoted value loses a trailing ` # comment`.
export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

export function readDotenv(file) {
  if (!file || !existsSync(file)) return null;
  return parseDotenv(readFileSync(file, 'utf8'));
}

// Names in the example file (values ignored), in file order. Commented-out `# KEY=` lines are optional keys.
export function exampleKeys(text) {
  const required = [];
  const optional = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) {
      required.push(m[1]);
      continue;
    }
    m = /^#\s*([A-Z_][A-Z0-9_]*)=/.exec(line);
    if (m) optional.push(m[1]);
  }
  return { required, optional: optional.filter((k) => !required.includes(k)) };
}

export function keyStatus(env, key) {
  if (!env || !(key in env)) return 'missing';
  return env[key] === '' ? 'empty' : 'set';
}
