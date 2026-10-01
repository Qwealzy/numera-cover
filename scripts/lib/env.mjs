// Minimal .env handling without dependencies. Values are never printed by callers; only names and a status.
import { existsSync, readFileSync } from 'node:fs';

// KEY=VALUE per line; '#' comments and blank lines ignored; optional `export ` prefix. A value in single or
// double quotes is taken up to the matching quote (a `#` inside quotes is kept), and a trailing ` # comment`
// after it or after an unquoted value is dropped.
export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if (q === '"' || q === "'") {
      // Quoted: value runs to the matching closing quote; only whitespace or a ` # comment` may follow.
      const end = v.indexOf(q, 1);
      const rest = end > 0 ? v.slice(end + 1) : null;
      if (rest !== null && /^(\s+#.*|\s*)$/.test(rest)) v = v.slice(1, end);
      else v = v.replace(/\s+#.*$/, '').trim(); // unbalanced quote: keep it literally
    } else v = v.replace(/\s+#.*$/, '').trim();
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
