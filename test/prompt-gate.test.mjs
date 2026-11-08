import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { shouldRetrievePrompt, codeTermsOf, hitAnchoredToTerms } from '../dist/claude/prompt-gate.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shim = join(repo, 'scripts', 'grafly-devin-hook.cjs');
const { findIndex, autoBuildRoot, runtimeDir } = createRequire(import.meta.url)(shim);

test('clear conversation and tool-usage questions skip retrieval (18 examples)', () => {
  for (const prompt of [
    '', '   ', '응', '네, 알겠습니다.', '고마워요! 이해했어요.',
    '좋아요. 그대로 진행해주세요.', '지금 어디까지 진행됐어?', '작업은 잘 되고 있어?',
    'Thanks for the explanation!', 'Yes, please go ahead.', 'Sounds good, continue.',
    'What is the status?', 'Are you still working?', 'Any updates?',
    'What tools do you use most often?', 'Can Grafly reduce tool calls?',
    'grafly를 쓰면 tool call이 얼마나 줄어들까?',
    'grafly를 사용하면 tool call이 줄어들긴할텐데. 너가 작업하면서 가장 많이쓰는 tool은 뭐가있어?',
  ]) assert.equal(shouldRetrievePrompt(prompt), false, prompt);
});

test('code anchors, mixed requests and uncertain substantive prompts keep retrieval (22 examples)', () => {
  for (const prompt of [
    'foo()', 'src/a.ts', 'loadGraph', 'evaluate_tool_action', 'EACCES',
    'C:\\repo\\entry', '`foo`', '코드 찾아줘', '함수 설명해줘',
    'Thanks. Find callers of loadGraph.', '고마워. 오류 나는 코드 찾아줘.',
    'What tools do you use most? Fix the hook code too.',
    '도구 호출을 줄이는 코드를 찾아줘', 'How does authentication work?',
    '로그인이 가끔 실패하는 이유를 조사해줘', 'Describe the dependency flow',
    '이전 얘기한 문제를 더 자세히 조사해줘', '한번 브런치 때서 테스트 한 번 해볼래?',
    'Session history is unexpectedly missing', 'Explain the architecture of this project',
    'Can Grafly reduce tokens? Investigate cache eviction.',
    'tool call이 줄어들텐데. 인증 흐름도 조사해줘.',
  ]) assert.equal(shouldRetrievePrompt(prompt), true, prompt);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'grafly-prompt-gate-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  const marker = join(root, 'calls.jsonl');
  const cli = join(root, 'fake-cli.cjs');
  writeFileSync(cli, `
    require('node:fs').appendFileSync(process.env.GRAFLY_TEST_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
    console.log(JSON.stringify({coverage: 1, coverageStrong: 1, hits: [
      {title: 'loadGraph', pointer: 'src/graph.js:L1-L3', snippet: 'Load the saved graph'}
    ]}));
  `);
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(?:GRAFLY|GRAFT)_/.test(name) || name === 'CLAUDE_PROJECT_DIR') delete env[name];
  }
  Object.assign(env, { USERPROFILE: root, HOME: root, CLAUDE_CONFIG_DIR: join(root, '.claude'),
    GRAFLY_TEST_CLI: cli, GRAFLY_TEST_LOG: marker, GRAFLY_NO_SELF_UPDATE: '1' });
  function run(prompt, { adapter = false, event = 'prompt', cwd = root, message = false, session = 'gate-test' } = {}) {
    const payload = JSON.stringify({ cwd, session_id: session, [message ? 'message' : 'prompt']: prompt });
    const args = adapter ? [shim, event] : ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(pathToFileURL(join(repo, 'dist/claude/hooks.js')).href)}); await m.main(${JSON.stringify(event)});`];
    const result = spawnSync(process.execPath, args, { cwd, env: { ...env, GRAFLY_TEST_STDIN: payload },
      input: payload, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  }
  return { root, run, calls: () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('repository hook skips child retrieval and session writes for conversation', (t) => {
  const f = fixture(t);
  for (const prompt of ['Thanks for the explanation!', '너가 가장 많이 쓰는 tool은 뭐가있어?'])
    assert.equal(f.run(prompt), '');
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(join(f.root, 'grafly')), false);
});

test('repository hook retrieves short code queries and retains pointer deduplication', (t) => {
  const f = fixture(t);
  const first = JSON.parse(f.run('loadGraph'));
  assert.equal(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(first.hookSpecificOutput.additionalContext, /src\/graph.js:L1-L3/);
  assert.equal(f.run('loadGraph'), '');
  assert.equal(f.calls().length, 2);
  assert.deepEqual(f.calls()[0], ['ask', 'loadGraph', '.', '--json', '-n', '3']);
  const session = JSON.parse(readFileSync(join(f.root, '.grafly/.cache/session/gate-test.json'), 'utf8'));
  assert.equal(session.lastQuery, 'loadGraph');
  assert.deepEqual(session.injectedPointers, ['src/graph.js:L1-L3']);
});

test('a no-change request adds the read-only hint; other prompts do not', (t) => {
  const f = fixture(t);
  const plain = JSON.parse(f.run('loadGraph 호출 위치 찾아줘'));
  assert.doesNotMatch(plain.hookSpecificOutput.additionalContext, /--read-only/);
  for (const [prompt, session] of [['loadGraph 위치를 알려 주세요. 파일은 수정하지 마세요.', 'ko'],
    ["Find loadGraph callers; don't modify anything.", 'en']]) {
    const context = JSON.parse(f.run(prompt, { session })).hookSpecificOutput.additionalContext;
    assert.match(context, /^\[grafly\] no-change request: add --read-only/);
    assert.match(context, /src\/graph.js:L1-L3/);
  }
});

test('a no-change prompt runs the real ask read-only and leaves the index and session untouched', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'grafly-prompt-readonly-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const repoDir = join(root, 'repo'), service = join(root, 'service');
  mkdirSync(repoDir); mkdirSync(service);
  writeFileSync(join(service, 'config.json'), JSON.stringify({ xerjUrl: null }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repoDir, windowsHide: true }).status, 0);
  writeFileSync(join(repoDir, '.gitignore'), '.grafly/\n');
  writeFileSync(join(repoDir, 'alpha.js'), 'export function alphaHandler() { return 1; }\n');
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(?:GRAFLY|GRAFT)_/i.test(key) && key !== 'CLAUDE_PROJECT_DIR'));
  Object.assign(env, { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, '.claude'),
    GRAFLY_SEARCH_HOME: service, GRAFLY_NO_SELF_UPDATE: '1' });
  const built = spawnSync(process.execPath, [join(repo, 'dist/entry.js'), 'build', '.'],
    { cwd: repoDir, env, encoding: 'utf8', windowsHide: true });
  assert.equal(built.status, 0, built.stderr);
  // A stale graph and a cold answer cache: a writing ask would refresh and cache.
  writeFileSync(join(repoDir, 'alpha.js'), 'export function alphaHandler() { return 2; }\nexport function betaHelper() {}\n');
  const ctx = join(repoDir, '.grafly');
  const snapshot = () => Object.fromEntries(readdirSync(ctx, { recursive: true }).map((name) => {
    const info = statSync(join(ctx, name));
    return [name, info.isFile() ? `${info.mtimeMs}:${readFileSync(join(ctx, name)).toString('base64')}` : 'dir'];
  }));
  const hook = (prompt) => {
    const payload = JSON.stringify({ cwd: repoDir, session_id: 'readonly-test', prompt });
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(pathToFileURL(join(repo, 'dist/claude/hooks.js')).href)}); await m.main('prompt');`],
      { cwd: repoDir, env: { ...env, GRAFLY_TEST_STDIN: payload }, input: payload, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const before = snapshot();
  const quiet = JSON.parse(hook('alphaHandler 위치를 알려 주세요. 파일은 수정하지 마세요.')).hookSpecificOutput.additionalContext;
  assert.match(quiet, /^\[grafly\] no-change request/);
  assert.match(quiet, /alpha\.js/);
  assert.deepEqual(snapshot(), before);
  // Control: the same lookup without the restriction writes (refresh, cache, session).
  hook('alphaHandler 위치를 알려 주세요.');
  assert.notDeepEqual(snapshot(), before);
  assert.equal(existsSync(join(ctx, '.cache/session/readonly-test.json')), true);
});

test('Codex/Devin adapter applies the gate and preserves message-field compatibility', (t) => {
  const f = fixture(t);
  const project = join(f.root, 'project');
  mkdirSync(join(project, 'grafly/.graph'), { recursive: true });
  writeFileSync(join(project, 'grafly/.graph/wiring.json'), '{}');
  assert.equal(f.run('Thanks for the explanation!', { adapter: true, cwd: project }), '');
  assert.deepEqual(f.calls(), []);
  const output = JSON.parse(f.run('고마워. loadGraph 함수 찾아줘.', { adapter: true, cwd: project, message: true }));
  assert.match(output.hookSpecificOutput.additionalContext, /src\/graph.js/);
  assert.equal(f.calls().length, 1);
});

test('home adapter gates before federation while retaining orientation and exact lookup', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'grafly'));
  writeFileSync(join(f.root, 'grafly/workspace.json'), JSON.stringify({ version: 1, children: [] }));
  assert.equal(f.run('Thanks for the explanation!', { adapter: true }), '');
  assert.equal(existsSync(join(f.root, 'grafly/.cache')), false);
  const orientation = JSON.parse(f.run('', { adapter: true, event: 'session-start' }));
  assert.match(orientation.hookSpecificOutput.additionalContext, /Home workspace: 0/);
  const exact = JSON.parse(f.run('loadGraph', { adapter: true }));
  assert.match(exact.hookSpecificOutput.additionalContext, /grafly grep "loadGraph"/);
  // Code term, but no indexed hit is literally `auth_module`: the unanchored pack injects nothing and leaves no session.
  assert.equal(f.run('Find the auth_module', { adapter: true }), '');
  assert.equal(existsSync(join(f.root, 'grafly/.cache/session/gate-test.json')), false);
});

test('home workspace skips federated retrieval for prose prompts without code terms', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'grafly'));
  writeFileSync(join(f.root, 'grafly/workspace.json'), JSON.stringify({ version: 1, children: [] }));
  // Passes the conversation gate but carries no code-shaped term: no emit, no session write.
  assert.equal(f.run('이번 주 작업 내용 정리해줘', { adapter: true }), '');
  assert.equal(f.run('summarize what this workspace holds', { adapter: true }), '');
  assert.equal(existsSync(join(f.root, 'grafly/.cache/session/gate-test.json')), false);
  // A code-shaped prompt passes the term gate, but with no anchored hit it
  // still emits nothing and writes nothing (empty workspace).
  assert.equal(f.run('check loadGraph()', { adapter: true }), '');
  assert.equal(existsSync(join(f.root, 'grafly/.cache/session/gate-test.json')), false);
});

test('home workspace injects only hits a prompt code term literally names', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'grafly'));
  const child = join(f.root, 'project');
  mkdirSync(join(child, 'grafly/.graph'), { recursive: true });
  writeFileSync(join(child, 'grafly/.graph/wiring.json'), JSON.stringify({
    version: 1, meta: {}, nodes: [
      { id: 'file:auth.js', kind: 'file', name: 'auth.js', path: 'auth.js', chars: 2000 },
      { id: 'fn:authenticateUser', kind: 'function', name: 'authenticateUser', path: 'auth.js', span: 'L1-L3', signature: 'authenticateUser(token)', summary: 'Authenticate user token' },
      { id: 'fn:checkSize', kind: 'function', name: 'checkSize', path: 'io.js', span: 'L5-L9', summary: 'Bounds a check' },
      { id: 'fn:run', kind: 'function', name: 'run', path: 'cli.js', span: 'L2-L8', summary: 'Runs the cli' },
    ], edges: [],
  }));
  writeFileSync(join(f.root, 'grafly/workspace.json'), JSON.stringify({ version: 1, children: ['project'] }));
  // Tool directive: the only code term is `run_12a39a18c069`; fuzzy hits like
  // checkSize/run are not the named thing, so nothing injects and no session is written.
  assert.equal(f.run('You have 1 orchestration message. Run `orca orchestration check --run run_12a39a18c069`.', { adapter: true }), '');
  assert.equal(existsSync(join(f.root, 'grafly/.cache/session/gate-test.json')), false);
  // A named symbol that IS indexed still injects.
  const hit = JSON.parse(f.run('where does authenticateUser validate tokens', { adapter: true }));
  assert.match(hit.hookSpecificOutput.additionalContext, /authenticateUser/);
});

test('anchor terms keep only hits the prompt literally names', () => {
  const terms = codeTermsOf('You have 1 orchestration message. Run `orca orchestration check --run run_12a39a18c069`.');
  assert.deepEqual([...terms], ['run_12a39a18c069']);
  // A backticked single identifier is an anchor; words inside a command span are not.
  assert.deepEqual([...codeTermsOf('`login` 설명해줘')], ['login']);
  assert.deepEqual([...codeTermsOf('fix `src/auth.js` please')].sort(), ['src/auth.js']);
  for (const hit of [
    { title: 'checkSize · method', pointer: 'proj/IO/ProjectStore.swift:L235-L240' },
    { title: 'Check · function', pointer: 'proj/src/ui/OptionsBar.tsx:L30-L32' },
    { title: 'run · function', pointer: 'proj/src-tauri/src/lib.rs:L32-L55' },
    { title: 'loadGraphImpl · function', pointer: 'p/g.js:L1-L2' },
    { title: 'LiveMaskGraph · enum', pointer: 'p/m.swift:L3-L20' },
  ]) assert.equal(hitAnchoredToTerms(hit, new Set([...terms, 'loadGraph'])), false, hit.title);
  // A path term requires a directory-suffix match: same-basename files in other projects don't anchor.
  assert.equal(hitAnchoredToTerms({ title: 'x · file', pointer: 'other/lib/auth.js' }, new Set(['src/auth.js'])), false);
  assert.equal(hitAnchoredToTerms({ title: 'x · file', pointer: 'proj/src/auth.js:L1-L2' }, new Set(['src/auth.js'])), true);
  for (const [hit, termSet] of [
    [{ title: 'authenticateUser · function', pointer: 'p/auth.js:L1-L3' }, ['authenticateUser']],
    [{ title: 'Authentication policy', pointer: 'p/auth.js' }, ['authentication_policy']],
    [{ title: 'x · file', pointer: 'p/src/auth.js:L1-L2' }, ['auth.js']],
    [{ title: 'x · file', pointer: 'p/src/auth.js' }, ['src/auth.js']],
    [{ title: 'run_12a39a18c069 · function', pointer: 'p/cli.js:L2-L8' }, ['run_12a39a18c069']],
  ]) assert.equal(hitAnchoredToTerms(hit, new Set(termSet)), true, JSON.stringify(hit));
});

test('conversation cannot start an automatic build in an unindexed Git repository', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, '.git'));
  assert.equal(f.run('Yes, please go ahead.', { adapter: true }), '');
  assert.equal(existsSync(join(f.root, 'grafly/.cache/auto-build.stamp')), false);
});

test('repository adapter retains new short and mixed task queries through the real hook boundary', (t) => {
  const f = fixture(t);
  const project = join(f.root, 'project');
  mkdirSync(join(project, 'grafly/.graph'), { recursive: true });
  writeFileSync(join(project, 'grafly/.graph/wiring.json'), '{}');
  const prompts = ['auth', 'App.vue', '로그인 오류', '401',
    'Reduce tool calls in the renderer.', '토큰 절약하도록 캐시 붙여줘',
    'Would Grafly save tokens? Benchmark it against the current renderer.',
    'What tools do you use most? Also profile memory allocation.'];
  for (const [i, prompt] of prompts.entries()) {
    const output = JSON.parse(f.run(prompt, { adapter: true, cwd: project, session: `task-${i}` }));
    assert.match(output.hookSpecificOutput.additionalContext, /src\/graph.js:L1-L3/);
    assert.equal(f.calls().length, i + 1, prompt);
    assert.equal(f.calls()[i][1], prompt);
  }
});

test('chat cannot mutate session state; duplicate suppression stays isolated across sessions', (t) => {
  const f = fixture(t);
  const project = join(f.root, 'project');
  mkdirSync(join(project, 'grafly/.graph'), { recursive: true });
  writeFileSync(join(project, 'grafly/.graph/wiring.json'), '{}');
  const opts = { adapter: true, cwd: project, session: 'session-a' };
  assert.match(f.run('loadGraph', opts), /src\/graph.js/);
  const state = join(project, 'grafly/.cache/session/session-a.json');
  const before = readFileSync(state, 'utf8');
  assert.equal(f.run('Can Grafly save tokens?', opts), '');
  assert.equal(f.run('감사합니다. 네, 진행해주세요.', opts), '');
  assert.equal(readFileSync(state, 'utf8'), before);
  assert.equal(f.calls().length, 1);
  assert.equal(f.run('loadGraph', opts), '');
  assert.match(f.run('loadGraph', { ...opts, session: 'session-b' }), /src\/graph.js/);
  assert.equal(f.run('loadGraph', { ...opts, session: 'session-b' }), '');
  assert.equal(f.calls().length, 4);
});

test('home adapter honors thread_id session isolation without a session_id', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'grafly'));
  const child = join(f.root, 'project');
  mkdirSync(join(child, 'grafly/.graph'), { recursive: true });
  writeFileSync(join(child, 'grafly/.graph/wiring.json'), JSON.stringify({
    version: 1, meta: {}, nodes: [
      { id: 'fn:request_scheduling', kind: 'function', name: 'request_scheduling', path: 'sched.js', span: 'L1-L5', summary: 'Queues a request' },
    ], edges: [],
  }));
  writeFileSync(join(f.root, 'grafly/workspace.json'), JSON.stringify({ version: 1, children: ['project'] }));
  for (const thread of ['thread-a', 'thread-b']) {
    const result = spawnSync(process.execPath, [shim, 'prompt'], { cwd: f.root,
      env: { ...process.env, USERPROFILE: f.root, HOME: f.root, GRAFLY_NO_AUTO_INDEX: '1', GRAFLY_NO_SELF_UPDATE: '1' },
      input: JSON.stringify({ cwd: f.root, thread_id: thread, prompt: 'Inspect request_scheduling.' }),
      encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(f.root, `grafly/.cache/session/${thread}.json`)), true);
  }
});

test('auto-build root prefers the git checkout, falls back to the session folder, skips home', (t) => {
  const f = fixture(t);
  const loose = join(f.root, 'loose');
  const repo = join(f.root, 'repo');
  mkdirSync(loose);
  mkdirSync(join(repo, '.git'), { recursive: true });
  assert.equal(autoBuildRoot(join(repo, 'pkg', 'src'), f.root), repo);
  assert.equal(autoBuildRoot(loose, f.root), loose);
  assert.equal(autoBuildRoot(f.root, f.root), null, 'home stays silent');
  assert.equal(autoBuildRoot(resolve(sep), f.root), null, 'filesystem root stays silent');
  mkdirSync(join(f.root, '.git'));
  assert.equal(autoBuildRoot(loose, f.root), loose, 'a home checkout must not swallow $HOME');
});

test('runtime, config and package-cache directories never auto-index', (t) => {
  const f = fixture(t);
  // Pure path checks: these need no filesystem — the denylist matches components.
  for (const dir of [
    join('C:\\', 'Users', 'x', 'AppData', 'Local', 'Beakho', 'harness'), // the observed counterexample
    join('C:\\', 'proj', 'node_modules', 'dep'),
    join('C:\\', 'ProgramData', 'svc'),
  ]) assert.equal(runtimeDir(dir), true, dir);
  // The dot rule applies only to the first segment under home.
  assert.equal(runtimeDir(join('C:\\', 'Users', 'x', '.config', 'tool'), join('C:\\', 'Users', 'x')), true);
  assert.equal(runtimeDir(join('/', 'home', 'x', '.cache', 'y'), join('/', 'home', 'x')), true);
  assert.equal(runtimeDir(join('C:\\', 'Users', 'x', '.config', 'tool'), 'C:\\nonexistent-home'), false);
  // Hidden worktree dirs inside a project are legitimate working trees.
  assert.equal(runtimeDir(join('C:\\', 'Users', 'x', 'proj', '.claude', 'worktrees', 'w'), join('C:\\', 'Users', 'x')), false);
  // The OS temp dir stays allowed: tests and scratch work legitimately live there.
  assert.equal(runtimeDir(tmpdir()), false);
  assert.equal(runtimeDir(join(f.root, 'AppData', 'x')), false, 'fixture dirs sit under tmpdir');
  // autoBuildRoot returns null for each of them — no stamp, no spawn, no hint.
  for (const dir of [
    join('C:\\', 'Users', 'x', 'AppData', 'Local', 'Beakho', 'harness'),
    join('C:\\', 'proj', 'node_modules', 'dep'),
  ]) assert.equal(autoBuildRoot(dir, 'C:\\nonexistent-home'), null, dir);
  assert.equal(autoBuildRoot(join('C:\\', 'Users', 'x', '.config', 'tool'), join('C:\\', 'Users', 'x')), null);
  const realRuntime = join(homedir(), 'AppData', 'Local', 'Beakho', 'harness');
  assert.equal(autoBuildRoot(realRuntime), null);
  // End-to-end on a real excluded dir outside any index (Windows: ProgramData is writable).
  if (process.platform === 'win32') {
    const dir = join(process.env.ProgramData || 'C:\\ProgramData', 'grafly-h14-test');
    mkdirSync(dir, { recursive: true });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(f.run('fix loadGraph callers', { adapter: true, cwd: dir }), '');
    assert.equal(existsSync(join(dir, 'grafly', '.cache', 'auto-build.stamp')), false);
    assert.equal(existsSync(join(dir, '.grafly')), false);
  }
});

test('hidden worktree dirs inside a project auto-index; home dot-dirs do not', (t) => {
  const home = homedir();
  const base = join(home, 'grafly-h14-wt');
  const wt = join(base, '.claude', 'worktrees', 'x');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), 'gitdir: ..\n'); // worktree pointer file, not a dir
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(autoBuildRoot(wt), wt, '<repo>/.claude/worktrees/<name> git root stays indexable');
  assert.equal(runtimeDir(join(home, '.codex', 'x')), true);
  assert.equal(autoBuildRoot(join(home, '.codex', 'x')), null);
});

test('home indexes remain isolated from unindexed projects and unrelated directories', (t) => {
  const f = fixture(t);
  const touch = (relative) => {
    const file = join(f.root, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{}');
  };
  touch('grafly/workspace.json');
  touch('projects/indexed/.git/HEAD');
  touch('projects/indexed/grafly/.graph/wiring.json');
  touch('projects/indexed/src/a.js');
  touch('projects/unindexed/.git/HEAD');
  touch('projects/indexed/nested/.git/HEAD');
  touch('AppData/Local/example/a.js');
  assert.equal(findIndex(f.root, f.root), f.root);
  assert.equal(findIndex(join(f.root, 'projects/indexed/src'), f.root), join(f.root, 'projects/indexed'));
  for (const relative of ['projects/unindexed', 'projects/indexed/nested', 'AppData/Local/example', 'projects'])
    assert.equal(findIndex(join(f.root, relative), f.root), null);
  if (process.platform === 'win32') {
    assert.equal(findIndex('\\\\?\\' + f.root, f.root), '\\\\?\\' + f.root);
    assert.equal(findIndex('\\\\?\\' + join(f.root, 'AppData'), f.root), null);
  }
});
