// Regenerates src/data/grid.json with the repo's own engine (waitlist/scripts/gen-grid.py). The engine's Python lives in a
// virtualenv: set NUMERA_PYTHON, or this uses engine/.venv of this checkout or of the main checkout that owns it.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(SITE, '..');
const candidates = [process.env.NUMERA_PYTHON];
try {
  const common = execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  for (const root of [REPO, path.dirname(common)])
    candidates.push(path.join(root, 'engine', '.venv', 'Scripts', 'python.exe'), path.join(root, 'engine', '.venv', 'bin', 'python'));
} catch {
  // not a git checkout
}
const py = candidates.find((c) => c && existsSync(c));
if (!py) {
  console.error('no engine Python found; set NUMERA_PYTHON to the engine/.venv python');
  process.exit(1);
}
execFileSync(py, [path.join(SITE, 'scripts', 'gen-grid.py')], { stdio: 'inherit', cwd: REPO });
