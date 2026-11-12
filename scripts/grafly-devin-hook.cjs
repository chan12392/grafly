// Devin/Codex hook shim for grafly: inside a repo that already has a grafly
// index it delegates to grafly's own Claude-format hooks (same injection
// contract, session state, and timeouts as upstream). Inside a directory with
// NO index it kicks off a background `grafly build` once — a git checkout
// indexes its root; other directories require an explicit build — so the graph appears
// without the user ever typing a command. The explicit home workspace searches
// saved project graphs; home itself and filesystem roots stay silent.
// Usage: node grafly-devin-hook.cjs <session-start|prompt>
// With ~/.grafly/auto-deep.json enabled, git projects also queue a cached
// deep pass. The optional worker never delays retrieval or provisions a model.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { homedir } = require('os');
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');

const EVENT = process.argv[2] || 'prompt';
// Filled by the installer: a copied hook must work with local/npx installations.
const INSTALLED_DIST = null;
// Prefer the installing package, then the adjacent source for checkout use.
// Otherwise find the global npm install: the prefix is %APPDATA%\npm for the
// per-user layout but equals the node install dir for a single-dir layout
// (e.g. node in %LOCALAPPDATA%\Programs\nodejs), so probe both then npm itself.
function pkgDist() {
  const candidates = [
    INSTALLED_DIST,
    path.resolve(__dirname, '..', 'dist'),
    path.join(path.dirname(process.execPath), 'node_modules', 'grafly', 'dist'),
    process.env.APPDATA && path.isAbsolute(process.env.APPDATA) ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'grafly', 'dist') : null,
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'claude', 'hooks.js'))
        && fs.existsSync(path.join(dir, 'util', 'background.cjs'))) return dir;
  }
  try {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const root = execFileSync(process.platform === 'win32' ? process.execPath : 'npm',
      process.platform === 'win32' ? [npmCli, 'root', '-g'] : ['root', '-g'], {
      cwd: path.dirname(process.execPath),
      encoding: 'utf8', timeout: 10000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const dir = path.join(root, 'grafly', 'dist');
    if (fs.existsSync(path.join(dir, 'claude', 'hooks.js'))
        && fs.existsSync(path.join(dir, 'util', 'background.cjs'))) return dir;
  } catch { /* npm unavailable — the optional hook stays silent */ }
  return null;
}
const PKG = pkgDist();
if (!PKG) { process.stdout.write('{}\n'); process.exit(0); }
const ENTRY = path.join(PKG, 'claude', 'hooks.js');
const CLI = path.join(PKG, 'cli.js');
let spawnBackground;
try { ({ spawnBackground } = require(path.join(PKG, 'util', 'background.cjs'))); }
catch { process.stdout.write('{}\n'); process.exit(0); }
let indexDir;
try {
  ({ indexDir } = require(path.join(PKG, 'context', 'location.cjs')));
} catch {
  // Fail-open copy of location.cjs so a broken/partial package never kills
  // the hook load; hosts must not stall the prompt on a missing shim dep.
  indexDir = (root, override) => {
    if (override) return path.isAbsolute(override) ? override : path.join(root, override);
    for (const name of ['.grafly', 'grafly', 'graft']) {
      const dir = path.join(root, name);
      if (fs.existsSync(path.join(dir, '.graph', 'wiring.json')) ||
          fs.existsSync(path.join(dir, 'workspace.json'))) return dir;
    }
    return path.join(root, '.grafly');
  };
}
const EVENT_NAMES = { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit' };
const BUILD_STALE_MS = 60 * 60 * 1000; // retry a failed build at most hourly
const SELF_UPDATE_MS = 24 * 60 * 60 * 1000; // self-update probe at most daily
const STARTUP_DEDUP_MS = 5000;

// A home workspace can load both the account and project hook registrations.
// Suppress only simultaneous, identical startup orientation. A resume/compact,
// changed index list, different session, or later startup still gets its context.
// Atomic creation also covers concurrent registrations; cache failures emit.
function claimStartup(root, input, context, now = Date.now()) {
  const id = input.session_id || input.thread_id || process.env.CODEX_THREAD_ID;
  if (!id || (input.source && input.source !== 'startup')) return true;
  const key = createHash('sha256').update(JSON.stringify([id, context])).digest('hex');
  try {
    const file = path.join(indexDir(root), '.cache', 'hook-startup', `${key}.stamp`);
    require(path.join(PKG, 'util', 'safe-path.cjs')).assertNoSymlinks(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      // NTFS and the Windows coarse wall clock can differ by a few milliseconds.
      // A slightly future timestamp still belongs to the same startup burst.
      const age = now - Math.floor(fs.statSync(file).mtimeMs);
      if (age >= -1000 && age < STARTUP_DEDUP_MS) return false;
      fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') return true;
    }
    try {
      fs.writeFileSync(file, '', { flag: 'wx' });
      return true;
    } catch (error) {
      return error.code !== 'EEXIST';
    }
  } catch { return true; }
}

// Grafly builds write <repo>/grafly/; legacy <repo>/graft/ indexes still work
// until `grafly migrate` rewrites them, so accept either.
function hasIndex(dir) {
  for (const name of ['.grafly', 'grafly', 'graft']) {
    if (fs.existsSync(path.join(dir, name, '.graph', 'wiring.json')) ||
        fs.existsSync(path.join(dir, name, 'workspace.json'))) return true;
  }
  return false;
}

function findUp(start, test) {
  let cur = path.resolve(start);
  for (;;) {
    if (test(cur)) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function samePath(a, b) {
  const normalize = (p) => path.resolve(p).replace(/^\\\\\?\\/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

// An unindexed Git checkout must not inherit the home workspace. The home
// workspace is opt-in by cwd, so AppData and other non-project folders stay quiet.
function findIndex(start, home = homedir()) {
  let cur = path.resolve(start);
  for (;;) {
    if (samePath(cur, home) && !samePath(cur, start)) return null;
    if (hasIndex(cur)) return cur;
    if (fs.existsSync(path.join(cur, '.git'))) return null;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function readStdin(ms = 3000) {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      buf += c;
      if (Buffer.byteLength(buf) > 1024 * 1024) { buf = ''; process.stdin.destroy(); resolve(''); }
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
    setTimeout(() => resolve(buf), ms).unref();
  });
}

function emit(context) {
  const name = EVENT_NAMES[EVENT];
  if (name) process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: name, additionalContext: context },
  }));
}

// Pick what a background build indexes: the enclosing git checkout's root, or
// the session folder itself when no checkout wraps it. A checkout rooted at
// the home directory (dotfiles style) must not swallow all of $HOME, and
// sessions opened at home or a filesystem root stay silent.
function autoBuildRoot(start, home = homedir()) {
  const git = findUp(start, (d) => fs.existsSync(path.join(d, '.git')));
  if (git && !samePath(git, home)) return git;
  return null; // Opening an arbitrary directory is not consent to index it.
}

// Kick one detached `grafly build` per directory; the stamp debounces retries.
function tryAutoBuild(start) {
  if (process.env.GRAFLY_NO_AUTO_INDEX || process.env.GRAFT_NO_AUTO_INDEX) return false;
  const root = autoBuildRoot(start);
  if (!root) return false;
  try {
    const ctxDir = indexDir(root, process.env.GRAFLY_DIR || process.env.GRAFT_DIR);
    const stamp = path.join(ctxDir, '.cache', 'auto-build.stamp');
    require(path.join(PKG, 'util', 'safe-path.cjs')).assertNoSymlinks(stamp);
    if (fs.existsSync(stamp) && Date.now() - fs.statSync(stamp).mtimeMs < BUILD_STALE_MS) return false;
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, new Date().toISOString());
    spawnBackground(process.execPath, [CLI, 'build', root], { cwd: root });
    return true;
  } catch { return false; }
}

// The daily self-update probe fires only on session-start, and only when the
// stamp is missing or older than SELF_UPDATE_MS — exported for tests.
function selfUpgradeDue(stampPath, now = Date.now(), staleMs = SELF_UPDATE_MS) {
  try {
    if (!fs.existsSync(stampPath)) return true;
    return now - Math.floor(fs.statSync(stampPath).mtimeMs) >= staleMs;
  } catch { return true; }
}

// With GRAFLY_AUTO_UPDATE=1, once a day kick `grafly _self-upgrade`: it git-pulls the linked
// checkout (npm-linked installs ARE the repo — dist/ is the product, no build
// step) and then reconciles hook wiring, so dropped registrations self-heal.
// The stamp is written before spawn so a failing pull retries tomorrow, not
// every session. GRAFLY_NO_SELF_UPDATE opts out.
function maybeSelfUpgrade() {
  if (EVENT !== 'session-start' || process.env.GRAFLY_AUTO_UPDATE !== '1' ||
      process.env.GRAFLY_NO_SELF_UPDATE || process.env.GRAFT_NO_SELF_UPDATE) return false;
  const stamp = path.join(homedir(), '.grafly', '.cache', 'self-upgrade.stamp');
  try {
    if (!selfUpgradeDue(stamp)) return false;
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, new Date().toISOString());
    // cwd is pinned to the home dir — a detached process must not hold the
    // session's cwd (which can be a temp dir a caller later deletes).
    spawnBackground(process.execPath, [CLI, '_self-upgrade'], { cwd: homedir() });
    return true;
  } catch { return false; }
}

async function tryAutoDeep(start, input = {}) {
  const root = findUp(start, d => fs.existsSync(path.join(d, '.git')));
  if (!root) return false;
  try {
    const { scheduleAutoDeep } = await import(pathToFileURL(path.join(PKG, 'hosts', 'auto-deep.js')).href);
    return scheduleAutoDeep(root, { sessionId: EVENT === 'session-start' ? (input.session_id || input.thread_id || process.env.CODEX_THREAD_ID) : undefined, force: EVENT === 'session-start' });
  } catch { return false; }
}

// Use the installed federation and relevance gate directly: home prompts read
// existing graphs without the CLI's automatic refresh, upkeep, or network work.
async function homeWorkspace(root, input) {
  const workspace = JSON.parse(fs.readFileSync(path.join(indexDir(root), 'workspace.json'), 'utf8'));
  if (workspace.version !== 1 || !Array.isArray(workspace.children)) return;
  if (EVENT === 'session-start') {
    const context = `[grafly] Home workspace: ${workspace.children.length} project indexes.\n` +
      `Projects: ${workspace.children.join(', ')}\n` +
      'grafly ask "<q>" . --source --no-refresh or grafly grep "<pat>" . --no-refresh over saved indexes; verify source before editing.';
    if (claimStartup(root, input, context)) emit(context);
    return;
  }
  const prompt = String(input.prompt || '').trim();
  if (EVENT !== 'prompt') return;
  // Cross-project ask can rank partial identifier tokens ahead of an exact
  // symbol. Route bare identifiers to the literal-search command instead.
  if (/^[A-Za-z_$][\w$]*$/.test(prompt)) {
    emit(`[grafly home] grafly grep ${JSON.stringify(prompt)} . --fixed --no-refresh — every indexed occurrence.`);
    return;
  }
  const [{ federateAsk }, { relevantRetrieval }, { readSession, writeSession }] = await Promise.all([
    import(pathToFileURL(path.join(PKG, 'graph', 'workspace.js')).href),
    import(pathToFileURL(path.join(PKG, 'claude', 'format.js')).href),
    import(pathToFileURL(path.join(PKG, 'claude', 'state.js')).href),
  ]);
  const id = input.session_id || input.thread_id || process.env.CODEX_THREAD_ID || 'default';
  const session = readSession(root, id);
  const result = federateAsk(root, undefined, prompt, { limit: 3 });
  const context = relevantRetrieval(result, session, 3);
  if (context) emit('[grafly home] Saved indexes — add --no-refresh; verify freshness before editing.\n' + context);
  writeSession(root, id, session);
}

async function main() {
  if (!fs.existsSync(ENTRY) || !fs.existsSync(CLI)) return;
  maybeSelfUpgrade();
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw); } catch { /* cwd fallback below */ }
  if (EVENT === 'pre-tool') {
    const { routeHook } = await import(pathToFileURL(path.join(PKG, 'tool-output', 'route.js')).href);
    process.stdout.write(JSON.stringify(routeHook('devin', input)));
    return;
  }
  if (!input.prompt && input.message) input.prompt = input.message;
  if (EVENT === 'prompt') {
    const { shouldRetrievePrompt } = await import(pathToFileURL(path.join(PKG, 'claude', 'prompt-gate.js')).href);
    if (!shouldRetrievePrompt(input.prompt)) return;
  }
  const start = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = findIndex(start);
  if (!root) {
    if (await tryAutoDeep(start, input))
      emit('[grafly] no index yet — queued structural + deep indexing in the background. Retrieval starts when the structural graph is available; deep status: node "' + path.join(PKG, 'hosts', 'auto-deep.js') + '" status');
    else if (tryAutoBuild(start))
      emit('[grafly] no index yet — indexing this directory in the background (grafly build). Retrieval switches on automatically once it finishes.');
    return;
  }
  if (samePath(root, homedir()) && fs.existsSync(path.join(indexDir(root), 'workspace.json'))) {
    await homeWorkspace(root, input);
    return;
  }
  await tryAutoDeep(root, input);
  process.env.CLAUDE_PROJECT_DIR = root;
  // hooks.js reads fd 0 synchronously (already consumed above); GRAFLY_TEST_STDIN
  // is its input seam, so hand the buffered payload through the env instead.
  // GRAFT_TEST_STDIN is set too so a pre-rename dist keeps working.
  const payload = Object.keys(input).length ? JSON.stringify(input) : raw;
  process.env.GRAFLY_TEST_STDIN = payload;
  process.env.GRAFT_TEST_STDIN = payload;
  const m = await import(pathToFileURL(ENTRY).href);
  await m.main(EVENT);
}

module.exports = { findIndex, claimStartup, autoBuildRoot, selfUpgradeDue };
if (require.main === module) main().catch(() => { /* fail-open: never block the user's prompt */ });
