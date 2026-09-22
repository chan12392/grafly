// Native Hermes shell-hook adapter. Deliberately never import the CLI/hooks:
// those surfaces perform upkeep, auto-indexing, and host-specific state writes.
const { readFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { homedir } = require('node:os');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

function samePath(a, b) {
  const normalize = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return normalize(a) === normalize(b);
}

function findIndex(start, home = homedir()) {
  if (typeof start !== 'string' || !path.isAbsolute(start)) return null;
  let root = path.resolve(start);
  for (;;) {
    if (samePath(root, home) && !samePath(root, start)) return null;
    for (const name of ['grafly', 'graft']) {
      const contextDir = path.join(root, name);
      if (existsSync(path.join(contextDir, 'workspace.json'))) return { root, contextDir, workspace: true };
      if (existsSync(path.join(contextDir, '.graph', 'wiring.json'))) return { root, contextDir };
    }
    if (existsSync(path.join(root, '.git'))) return null;
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}

async function retrieve(raw) {
  const input = JSON.parse(raw);
  if (input?.hook_event_name !== 'pre_llm_call' || typeof input.cwd !== 'string' ||
      typeof input.extra?.user_message !== 'string') return;
  const { shouldRetrievePrompt } = await import('../dist/claude/prompt-gate.js');
  if (!shouldRetrievePrompt(input.extra.user_message)) return;
  const index = findIndex(input.cwd);
  if (!index) return;
  if (index.workspace) {
    const workspace = JSON.parse(readFileSync(path.join(index.contextDir, 'workspace.json'), 'utf8'));
    if (workspace?.version !== 1 || !Array.isArray(workspace.children) || !workspace.children.length ||
        !workspace.children.every(child => typeof child === 'string' && child &&
          !path.posix.isAbsolute(child) && !path.win32.isAbsolute(child) &&
          !child.includes(':') && !child.split(/[\\\\/]/).some(part => part === '..' || part === '.'))) return;
  }
  const session = input.session_id;
  const turn = input.extra.turn_id;
  if (typeof session !== 'string' || !session || typeof turn !== 'string' || !turn) return;
  // Exclusive empty marker is an atomic claim across parallel/replayed hooks.
  // No raw identifiers, prompts, history, or retrieval result are persisted.
  const key = createHash('sha256').update(JSON.stringify([session, turn])).digest('hex');
  const cache = path.join(index.contextDir, '.cache', 'hermes');
  mkdirSync(cache, { recursive: true });
  try { writeFileSync(path.join(cache, `${key}.seen`), '', { flag: 'wx', mode: 0o600 }); }
  catch { return; } // seen, read-only, or unavailable: skip rather than retry
  const { relevantRetrieval } = await import('../dist/claude/format.js');
  let result;
  if (index.workspace) {
    const { federateAsk } = await import('../dist/graph/workspace.js');
    result = federateAsk(index.root, index.contextDir, input.extra.user_message, { limit: 3 });
  } else {
    const { ask } = await import('../dist/ask/ask.js');
    result = ask(index.root, input.extra.user_message, { limit: 3, contextDir: index.contextDir });
  }
  return relevantRetrieval(result, {}, 3);
}

// Keep synchronous graph parsing/ranking off the watchdog thread. A timer in
// the retrieval thread cannot interrupt a CPU-bound query or a blocked read.
function main() {
  const requested = Number(process.env.GRAFLY_HERMES_TIMEOUT_MS);
  const timeout = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 6000) : 6000;
  let done = false;
  function finish(context) {
    if (done) return;
    done = true;
    if (typeof context === 'string' && context) {
      const suffix = '\n[grafly] context truncated.';
      if (context.length > 8000) context = context.slice(0, 8000 - suffix.length) + suffix;
      process.stdout.write(JSON.stringify({ context }), () => process.exit(0));
    } else process.exit(0);
  }
  setTimeout(() => finish(), timeout);
  let raw = '', bytes = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 1024 * 1024) return finish();
    raw += chunk;
  });
  process.stdin.on('error', () => finish());
  process.stdin.on('end', () => {
    try {
      const worker = new Worker(__filename, { workerData: raw, stdout: true, stderr: true });
      worker.stdout.resume();
      worker.stderr.resume();
      worker.on('message', finish);
      worker.on('error', () => finish());
      worker.on('exit', () => finish());
    } catch { finish(); }
  });
}
module.exports = { findIndex };
if (require.main === module) {
  if (isMainThread) main();
  else retrieve(workerData).then(context => parentPort.postMessage(context), () => parentPort.postMessage(null));
}
