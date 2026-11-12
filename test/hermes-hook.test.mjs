import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const hook = resolve('scripts/grafly-hermes-hook.cjs');
test('Python adapters ignore cwd executables even when cwd appears on PATH', t => {
  const python = process.env.GRAFLY_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, [resolve('test/hermes-executable.test.py')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.error?.code === 'ENOENT') { t.skip('Python is not installed'); return; }
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /boundaries: passed/);
});
function fixture(t, indexed = true) {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'grafly-hermes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.git'));
  if (indexed) {
    mkdirSync(join(root, 'grafly', '.graph'), { recursive: true });
    writeFileSync(join(root, 'grafly', '.graph', 'wiring.json'), JSON.stringify({
      version: 1, meta: {}, nodes: [
        { id: 'file:auth.js', kind: 'file', name: 'auth.js', path: 'auth.js', chars: 2000 },
        { id: 'fn:authenticateUser', kind: 'function', name: 'authenticateUser', path: 'auth.js', span: 'L1-L3', signature: 'authenticateUser(token)', summary: 'Authenticate user token' },
      ], edges: [],
    }));
  }
  return root;
}
function payload(root, extra = {}, session = 'session-one') {
  return { hook_event_name: 'pre_llm_call', session_id: session, cwd: root,
    extra: { user_message: 'authenticateUser', turn_id: 'turn-one', conversation_history: [], ...extra } };
}
function run(input, env = {}) {
  const result = spawnSync(process.execPath, [hook], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, GRAFLY_DIR: '', GRAFT_DIR: '', ...env },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stderr, '');
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

test('invalid envelopes stay silent instead of querying', t => {
  const root = fixture(t);
  for (const input of ['{broken', 'null', '[]', '42', {}, { ...payload(root), hook_event_name: 'post_llm_call' },
    payload(root, { user_message: null }), payload(root, { user_message: { text: 'authenticateUser' } })]) {
    assert.deepEqual(run(input), {});
  }
});

test('conversation gate skips chat but retains short identifiers and mixed tasks', async () => {
  const { shouldRetrievePrompt } = await import('../dist/claude/prompt-gate.js');
  for (const text of ['', '  ', 'thanks', 'yes go ahead', '설명 고마워요', 'what tools do you use most?', 'Can grafly save tokens?']) {
    assert.equal(shouldRetrievePrompt(text), false, text);
  }
  for (const text of ['authenticateUser', 'auth', 'Thanks, fix authenticateUser()', 'src/auth.js', '토큰 검증 코드 수정해줘']) {
    assert.equal(shouldRetrievePrompt(text), true, text);
  }
});

test('hook applies conversation gate before graph access', t => {
  const root = fixture(t);
  const graph = join(root, 'grafly', '.graph', 'wiring.json');
  writeFileSync(graph, readFileSync(graph, 'utf8').replaceAll('authenticateUser', 'thanks'));
  for (const user_message of ['thanks', '', '  ']) assert.deepEqual(run(payload(root, { user_message })), {});
});

test('indexed ancestor resolution respects Git and explicit home boundaries', async t => {
  const root = fixture(t);
  const nested = join(root, 'src', 'nested');
  mkdirSync(nested, { recursive: true });
  assert.match(run(payload(nested)).context, /authenticateUser/);
  const foreign = join(root, 'foreign');
  mkdirSync(join(foreign, '.git'), { recursive: true });
  assert.deepEqual(run(payload(foreign, {}, 'foreign-session')), {});
  rmSync(join(foreign, '.git'), { recursive: true });
  writeFileSync(join(foreign, '.git'), 'gitdir: ../worktree-meta');
  assert.deepEqual(run(payload(foreign, {}, 'foreign-session')), {});
  const { findIndex } = await import('../scripts/grafly-hermes-hook.cjs');
  assert.equal(findIndex(nested, root), null, 'do not inherit an indexed home');
  assert.equal(findIndex(root, root).root, root, 'explicit home remains eligible');
});

test('unindexed checkout stays silent without creating files', t => {
  const root = fixture(t, false);
  assert.deepEqual(run(payload(root)), {});
  assert.deepEqual(readdirSync(root), ['.git']);
});

test('turn IDs deduplicate tool-loop replay without leaking prompt or session paths', t => {
  const root = fixture(t);
  const session = '../unsafe/session\\name:with?chars';
  const input = payload(root, {}, session);
  assert.match(run(input).context, /authenticateUser/);
  assert.deepEqual(run({ ...input, extra: { ...input.extra, conversation_history: [{ role: 'tool', content: 'done' }] } }), {});
  assert.match(run(payload(root, { turn_id: 'turn-two' }, session)).context, /authenticateUser/);
  assert.match(run(payload(root, {}, 'new-session')).context, /authenticateUser/);
  assert.deepEqual(run(input), {}, 'out-of-order replay must also stay deduplicated');
  const cache = join(root, 'grafly', '.cache', 'hermes');
  const names = readdirSync(cache);
  assert.equal(names.length, 3);
  for (const name of names) {
    assert.match(name, /^[a-f0-9]{64}\.seen$/);
    assert.equal(readFileSync(join(cache, name), 'utf8'), '');
  }
});

test('deadline covers a stalled stdin stream', async () => {
  const child = spawn(process.execPath, [hook], { env: { ...process.env, GRAFLY_HERMES_TIMEOUT_MS: '100' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  const watchdog = setTimeout(() => child.kill(), 2500);
  const code = await new Promise(resolve => child.on('close', resolve));
  clearTimeout(watchdog);
  assert.equal(code, 0, 'must fail open itself rather than require external kill');
  assert.equal(out, '');
  assert.equal(err, '');
});

test('deadline interrupts a synchronously stalled retrieval', t => {
  const root = fixture(t);
  const preload = join(root, 'block-read.cjs');
  writeFileSync(preload, `const fs = require('node:fs'); const read = fs.readFileSync;
    fs.readFileSync = function(p, ...args) {
      if (String(p).endsWith('wiring.json')) { for (;;) {} }
      return read.call(this, p, ...args);
    };`);
  const started = Date.now();
  assert.deepEqual(run(payload(root), { NODE_OPTIONS: '--require="' + preload.split(String.fromCharCode(92)).join('/') + '"', GRAFLY_HERMES_TIMEOUT_MS: '300' }), {});
  assert.ok(Date.now() - started < 2500);
});

test('saved workspace retrieves children only when explicitly selected', t => {
  const home = fixture(t, false);
  const child = join(home, 'project');
  mkdirSync(child);
  const source = fixture(t);
  mkdirSync(join(child, 'grafly', '.graph'), { recursive: true });
  writeFileSync(join(child, 'grafly', '.graph', 'wiring.json'), readFileSync(join(source, 'grafly', '.graph', 'wiring.json')));
  mkdirSync(join(home, 'grafly'));
  writeFileSync(join(home, 'grafly', 'workspace.json'), JSON.stringify({ version: 1, children: ['project', 'unindexed'] }));
  assert.match(run(payload(home, { user_message: 'where does authenticateUser validate tokens' })).context, /project\/auth\.js/);
  assert.equal(readdirSync(home).includes('unindexed'), false);
});

for (const workspace of [false, true]) {
  test(`concept frontmatter is data-only in ${workspace ? 'saved workspace' : 'ordinary repo'} retrieval`, t => {
    const root = fixture(t);
    let cwd = root;
    if (workspace) {
      cwd = fixture(t, false);
      mkdirSync(join(cwd, 'grafly'));
      // A saved child must be below the workspace, not an arbitrary external path.
      const child = join(cwd, 'project');
      mkdirSync(join(child, 'grafly', '.graph'), { recursive: true });
      writeFileSync(join(child, 'grafly', '.graph', 'wiring.json'), readFileSync(join(root, 'grafly', '.graph', 'wiring.json')));
      writeFileSync(join(cwd, 'grafly', 'workspace.json'), JSON.stringify({ version: 1, children: ['project'] }));
    }
    const index = join(workspace ? join(cwd, 'project') : root, 'grafly');
    const concept = join(index, 'authentication.md');
    const guard = join(root, 'frontmatter-guard.cjs');
    const audit = join(root, 'frontmatter-effects.txt');
    writeFileSync(guard, `const fs = require('node:fs');
      const forbidden = () => { fs.appendFileSync(${JSON.stringify(audit)}, 'forbidden-call\\n'); throw Error('forbidden'); };
      for (const [name, methods] of Object.entries({ http: ['request','get'], https: ['request','get'], net: ['connect','createConnection'], tls: ['connect'], child_process: ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'] })) {
        const mod = require('node:' + name); for (const method of methods) mod[method] = forbidden;
      }
      globalThis.fetch = forbidden;
      require('node:module').syncBuiltinESMExports();`);
    const env = { NODE_OPTIONS: '--require="' + guard.split(String.fromCharCode(92)).join('/') + '"' };
    const query = 'authentication policy';
    const metadata = { slug: 'authentication', name: 'Authentication policy', sources: [{ path: 'auth.js' }], links: [{ to: 'tokens' }] };
    const body = '# Authentication\nAuthentication policy validates tokens.\n';
    for (const [label, data] of [['', 'slug: authentication\nname: Authentication policy\nsources:\n  - path: auth.js\nlinks:\n  - to: tokens'], ['yaml', 'name: Authentication policy\nsources: [{path: auth.js}]\nlinks: [{to: tokens}]'], ['json', JSON.stringify(metadata)]]) {
      writeFileSync(concept, `---${label}\n${data}\n---\n${body}`);
      const result = run(payload(cwd, { user_message: query, turn_id: 'normal-' + label }), env);
      assert.match(result.context, /1\. Authentication policy: (?:project\/)?auth\.js/);
      assert.match(result.context, /Authentication policy validates tokens\./);
    }
    const malicious = `(() => {
      require('node:fs').appendFileSync(${JSON.stringify(audit)}, 'marker\\n');
      try { require('node:child_process').spawn(process.execPath, ['-e', '']); } catch {}
      try { require('node:http').get('http://127.0.0.1:1'); } catch {}
      try { fetch('http://127.0.0.1:1'); } catch {}
      return ${JSON.stringify(metadata)};
    })()`;
    for (const label of ['javascript', 'js', 'JavaScript', ' javascript ', 'unknown', 'constructor', '__proto__']) {
      writeFileSync(concept, `\uFEFF---${label}\r\n${malicious}\r\n---\r\n${body}`);
      const result = run(payload(cwd, { user_message: query, turn_id: 'attack-' + label }), env);
      assert.deepEqual({ result, effects: readdirSync(root).includes('frontmatter-effects.txt') ? readFileSync(audit, 'utf8') : '' },
        { result: {}, effects: '' }, label);
    }
    // A second BOM must not become a new delimiter after validation.
    writeFileSync(concept, `\uFEFF\uFEFF---javascript\n${malicious}\n---\n${body}`);
    run(payload(cwd, { user_message: query, turn_id: 'double-bom' }), env);
    assert.equal(readdirSync(root).includes('frontmatter-effects.txt'), false, 'double BOM must not execute');
  });
}

test('legacy graft indexes and Windows cwd separators are supported', t => {
  const root = fixture(t);
  const graph = readFileSync(join(root, 'grafly', '.graph', 'wiring.json'));
  rmSync(join(root, 'grafly'), { recursive: true });
  mkdirSync(join(root, 'graft', '.graph'), { recursive: true });
  writeFileSync(join(root, 'graft', '.graph', 'wiring.json'), graph);
  const cwd = process.platform === 'win32' ? root.split(String.fromCharCode(92)).join('/') : root;
  assert.match(run(payload(cwd)).context, /authenticateUser/);
});

test('invalid workspace manifests never fall back to project discovery', t => {
  const root = fixture(t);
  const manifest = join(root, 'grafly', 'workspace.json');
  for (const value of [{ version: 99, children: [] }, { version: 1, children: ['..'] }, { version: 1, children: ['C:\\outside'] }, { version: 1, children: [] }]) {
    writeFileSync(manifest, JSON.stringify(value));
    assert.deepEqual(run(payload(root, { turn_id: JSON.stringify(value) })), {});
    assert.equal(readdirSync(join(root, 'grafly')).includes('.cache'), false);
  }
});

test('oversized payload is discarded before any indexed work', t => {
  const root = fixture(t);
  assert.deepEqual(run(payload(root, { user_message: 'authenticateUser', conversation_history: [{ content: 'x'.repeat(1024 * 1024) }] })), {});
  assert.equal(readdirSync(join(root, 'grafly')).includes('.cache'), false);
});

test('retrieval context is bounded even for huge indexed identifiers', t => {
  const root = fixture(t);
  const graph = join(root, 'grafly', '.graph', 'wiring.json');
  const data = JSON.parse(readFileSync(graph, 'utf8'));
  data.nodes[1].name = 'authenticateUser' + 'Z'.repeat(12000);
  writeFileSync(graph, JSON.stringify(data));
  const result = run(payload(root));
  assert.ok(result.context.length <= 8000);
  assert.match(result.context, /truncated/);
});

test('network and process launch guards remain unused with telemetry and Brain configured', t => {
  const root = fixture(t);
  const guard = join(root, 'guard.cjs');
  const audit = join(root, 'forbidden-call.txt');
  writeFileSync(guard, `const fs = require('node:fs');
    const forbidden = () => { fs.appendFileSync(${JSON.stringify(audit)}, 'called'); throw Error('forbidden'); };
    for (const [name, methods] of Object.entries({ http: ['request','get'], https: ['request','get'], net: ['connect','createConnection'], tls: ['connect'], child_process: ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'] })) {
      const mod = require('node:' + name); for (const method of methods) mod[method] = forbidden;
    }
    globalThis.fetch = forbidden;
    require('node:module').syncBuiltinESMExports();`);
  const graph = join(root, 'grafly', '.graph', 'wiring.json');
  const before = readFileSync(graph, 'utf8');
  const result = run(payload(root), { NODE_OPTIONS: '--require="' + guard.split(String.fromCharCode(92)).join('/') + '"', GRAFLY_POSTHOG_KEY: 'synthetic-key', GRAFLY_NPM_PACKAGE: 'synthetic-package', GRAFLY_BRAIN_URL: 'http://127.0.0.1:1' });
  assert.match(result.context, /authenticateUser/);
  assert.equal(readFileSync(graph, 'utf8'), before);
  assert.equal(readdirSync(root).includes('forbidden-call.txt'), false);
  assert.deepEqual(readdirSync(root).sort(), ['.git', 'grafly', 'guard.cjs']);
  assert.deepEqual(readdirSync(join(root, 'grafly')).sort(), ['.cache', '.graph']);
});

test('corrupt graph and unwritable state fail open without stdout errors', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'grafly', '.graph', 'wiring.json'), '{corrupt');
  assert.deepEqual(run(payload(root)), {});
  const other = fixture(t);
  writeFileSync(join(other, 'grafly', '.cache'), 'not a directory');
  assert.deepEqual(run(payload(other)), {});
});

test('missing session or turn identities are not guessed from prompt text', t => {
  const root = fixture(t);
  assert.deepEqual(run(payload(root, { turn_id: undefined })), {});
  assert.deepEqual(run(payload(root, {}, '')), {});
  assert.equal(readdirSync(join(root, 'grafly')).includes('.cache'), false);
});

test('parallel delivery atomically claims one context pack', async t => {
  const root = fixture(t);
  const outputs = await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => { try { assert.equal(code, 0); assert.equal(err, ''); resolve(out); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify(payload(root)));
  })));
  assert.equal(outputs.filter(Boolean).length, 1);
  assert.match(JSON.parse(outputs.find(Boolean)).context, /authenticateUser/);
});

test('native Hermes payload retrieves shared-engine pointers as additive context', t => {
  const root = fixture(t);
  const result = run(payload(root));
  assert.deepEqual(Object.keys(result), ['context']);
  assert.match(result.context, /authenticateUser/);
  assert.match(result.context, /auth\.js/);
  assert.doesNotMatch(result.context, /hookSpecificOutput/);
});
