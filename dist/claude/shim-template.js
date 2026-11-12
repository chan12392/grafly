// Generates the tiny `.cjs` shims committed into a repo's `.claude/helpers/`. Their only
// job is to locate the installed `grafly` package's `dist/claude/<entry>.js` and
// call into it — so the real logic lives in the package and upgrades with it.
//
// Candidates, cheapest first (no subprocess for 1–3):
//   1. `bakedDir`   — the absolute `dist/claude` Grafly was running from at init time.
//                     Correct with zero guesswork for whoever ran `grafly init`.
//   2. Only installation-side candidates; opened repositories are untrusted.
//   3. `execDir/../lib`  — the cheap legacy guess (covers nvm / classic prefix layout).
//   4. `npm root -g`     — authoritative global dir, layout-agnostic. Only shelled out to
//                     when 1–3 all miss; queried on demand — no on-disk cache, which on a
//                     shared machine would be a world-writable path an attacker could point
//                     at their own code for us to import.
//
// Among the candidates that exist we take the HIGHEST VERSION, not the first hit. First-hit
// silently pinned users to a stale Grafly forever: `bakedDir` points into one Node install's
// global node_modules, so switching Node versions (nvm/volta) or moving the install leaves
// the old directory on disk and still winning, and `npm i -g grafly@latest`
// upgrades a directory the shim never looks at. The upgrade appeared to work and changed
// nothing — the shim kept loading the version from whenever `grafly init` was last run.
function shim(entryFile, call, bakedDir) {
    return `#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const BAKED = ${JSON.stringify(bakedDir)};

// The dist/claude dir of grafly resolved from a base whose node_modules is searched.
function fromPkg(base) {
  try {
    const pkg = require.resolve('grafly/package.json', { paths: [base] });
    return path.join(path.dirname(pkg), 'dist', 'claude');
  } catch { return null; }
}

// The global node_modules dir per npm (handles Homebrew/Windows/volta). Queried on demand.
function globalRoot() {
  try {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const command = process.platform === 'win32' ? process.execPath : 'npm';
    const args = process.platform === 'win32' ? [npmCli, 'root', '-g'] : ['root', '-g'];
    const root = execFileSync(command, args, { cwd: path.dirname(process.execPath), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    return root || null;
  } catch { return null; /* npm unavailable */ }
}

// The version of the package a dist/claude dir belongs to, or null if unreadable.
function versionOf(distClaude) {
  try {
    return JSON.parse(fs.readFileSync(path.join(distClaude, '..', '..', 'package.json'), 'utf8')).version || null;
  } catch { return null; }
}

// Numeric-dotted compare of the release part; an unreadable version loses to any known one.
function newer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const p = (v) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
  const pa = p(a), pb = p(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// The highest-versioned dir in \`dirs\` that actually contains \`name\`, or null.
function best(dirs, name) {
  let bestDir = null, bestVer = null;
  for (const d of dirs) {
    if (!d || !fs.existsSync(path.join(d, name))) continue;
    const v = versionOf(d);
    if (bestDir === null || newer(v, bestVer)) { bestDir = d; bestVer = v; }
  }
  return bestDir;
}

function entry(name) {
  // Cheap candidates first, and only shell out to npm when every one of them misses.
  const cheap = [BAKED, fromPkg(path.join(path.dirname(process.execPath), '..', 'lib'))];
  const hit = best(cheap, name);
  if (hit) return path.join(hit, name);
  const gr = globalRoot();
  const global = gr && path.join(gr, 'grafly', 'dist', 'claude');
  if (global && fs.existsSync(path.join(global, name))) return path.join(global, name);
  return null; // An opened repository cannot select code for a user-level hook.
}

const file = entry(${JSON.stringify(entryFile)});
if (file) import(pathToFileURL(file).href).then((m) => ${call}).catch(() => { /* Grafly unavailable — no-op */ });
`;
}
export function statuslineShim(bakedDir) { return shim('statusline.js', 'm.main()', bakedDir); }
export function hooksShim(bakedDir) { return shim('hooks.js', 'm.main(process.argv[2])', bakedDir); }
