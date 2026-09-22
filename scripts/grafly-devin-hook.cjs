// Devin/Codex hook shim for grafly: inside a repo that already has a grafly
// index it delegates to grafly's own Claude-format hooks (same injection
// contract, session state, and timeouts as upstream). Inside a git repo with
// NO index it kicks off a background `grafly build` once, so the graph appears
// without the user ever typing a command. The explicit home workspace searches
// saved project graphs; other unindexed non-Git directories stay silent.
// Usage: node grafly-devin-hook.cjs <session-start|prompt>
// With ~/.grafly/auto-deep.json enabled, git projects also queue a cached
// deep pass. The optional worker never delays retrieval or provisions a model.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { homedir } = require('os');
const { spawn } = require('child_process');
const { createHash } = require('crypto');

const EVENT = process.argv[2] || 'prompt';
// In a checkout/package, use the adjacent source so branch tests exercise it.
// A standalone installed shim retains the global npm package fallback.
const LOCAL_DIST = path.resolve(__dirname, '..', 'dist');
const PKG = fs.existsSync(path.join(LOCAL_DIST, 'claude', 'hooks.js'))
  ? LOCAL_DIST : path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'grafly', 'dist');
const ENTRY = path.join(PKG, 'claude', 'hooks.js');
const CLI = path.join(PKG, 'cli.js');
const EVENT_NAMES = { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit' };
const BUILD_STALE_MS = 60 * 60 * 1000; // retry a failed build at most hourly
const STARTUP_DEDUP_MS = 5000;

// A home workspace can load both the account and project hook registrations.
// Suppress only simultaneous, identical startup orientation. A resume/compact,
// changed index list, different session, or later startup still gets its context.
// Atomic creation also covers concurrent registrations; cache failures emit.
function claimStartup(root, input, context, now = Date.now()) {
  const id = input.session_id || input.thread_id || process.env.CODEX_THREAD_ID;
  if (!id || (input.source && input.source !== 'startup')) return true;
  const key = createHash('sha256').update(JSON.stringify([id, context])).digest('hex');
  const file = path.join(root, 'grafly', '.cache', 'hook-startup', `${key}.stamp`);
  try {
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
  for (const name of ['grafly', 'graft']) {
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
    process.stdin.on('data', (c) => { buf += c; });
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

// Kick one detached `grafly build` per git repo; the stamp debounces retries.
function tryAutoBuild(start) {
  if (process.env.GRAFLY_NO_AUTO_INDEX || process.env.GRAFT_NO_AUTO_INDEX) return false;
  const root = findUp(start, (d) => fs.existsSync(path.join(d, '.git')));
  if (!root) return false;
  const ctxDir = process.env.GRAFLY_DIR || process.env.GRAFT_DIR || 'grafly';
  const stamp = path.join(root, ctxDir, '.cache', 'auto-build.stamp');
  try {
    if (fs.existsSync(stamp) && Date.now() - fs.statSync(stamp).mtimeMs < BUILD_STALE_MS) return false;
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, new Date().toISOString());
    spawn(process.execPath, [CLI, 'build', root], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch { return false; }
}

async function tryAutoDeep(start) {
  const root = findUp(start, d => fs.existsSync(path.join(d, '.git')));
  if (!root) return false;
  try {
    const { scheduleAutoDeep } = await import(pathToFileURL(path.join(PKG, 'hosts', 'auto-deep.js')).href);
    return scheduleAutoDeep(root);
  } catch { return false; }
}

// Use the installed federation and relevance gate directly: home prompts read
// existing graphs without the CLI's automatic refresh, upkeep, or network work.
async function homeWorkspace(root, input) {
  const workspace = JSON.parse(fs.readFileSync(path.join(root, 'grafly', 'workspace.json'), 'utf8'));
  if (workspace.version !== 1 || !Array.isArray(workspace.children)) return;
  if (EVENT === 'session-start') {
    const context = `[grafly] Home workspace: ${workspace.children.length} existing project indexes.\n` +
      `Projects: ${workspace.children.join(', ')}\n` +
      'Use grafly ask "<query>" . --source --no-refresh for ranked code locations, ' +
      'or grafly grep "<pattern>" . --no-refresh for indexed occurrences.\n' +
      'Results use saved project indexes; confirm source before editing. Refresh only the relevant project when needed.';
    if (claimStartup(root, input, context)) emit(context);
    return;
  }
  const prompt = String(input.prompt || '').trim();
  if (EVENT !== 'prompt') return;
  // Cross-project ask can rank partial identifier tokens ahead of an exact
  // symbol. Route bare identifiers to the literal-search command instead.
  if (/^[A-Za-z_$][\w$]*$/.test(prompt)) {
    emit(`[grafly home] Exact identifier lookup: grafly grep ${JSON.stringify(prompt)} . --fixed --no-refresh. ` +
      'Use the literal search to locate all indexed occurrences.');
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
  if (context) emit('[grafly home] Saved project indexes; verify source freshness. ' +
    'Add --no-refresh to home ask/grep commands; refresh only the relevant project when needed.\n' + context);
  writeSession(root, id, session);
}

async function main() {
  if (!fs.existsSync(ENTRY) || !fs.existsSync(CLI)) return;
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
    if (await tryAutoDeep(start))
      emit('[grafly] no index yet — queued structural + deep indexing in the background. Retrieval starts when the structural graph is available; deep status: node "' + path.join(PKG, 'hosts', 'auto-deep.js') + '" status');
    else if (tryAutoBuild(start))
      emit('[grafly] no index yet — building this repo in the background (grafly build). Retrieval switches on automatically once it finishes.');
    return;
  }
  if (samePath(root, homedir()) && fs.existsSync(path.join(root, 'grafly', 'workspace.json'))) {
    await homeWorkspace(root, input);
    return;
  }
  await tryAutoDeep(root);
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

module.exports = { findIndex, claimStartup };
if (require.main === module) main().catch(() => { /* fail-open: never block the user's prompt */ });
