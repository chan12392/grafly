import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { shouldRetrievePrompt } from '../dist/claude/prompt-gate.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shim = join(repo, 'scripts', 'grafly-devin-hook.cjs');
const { findIndex } = createRequire(import.meta.url)(shim);

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
    GRAFLY_TEST_CLI: cli, GRAFLY_TEST_LOG: marker });
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
  const session = JSON.parse(readFileSync(join(f.root, 'grafly/.cache/session/gate-test.json'), 'utf8'));
  assert.equal(session.lastQuery, 'loadGraph');
  assert.deepEqual(session.injectedPointers, ['src/graph.js:L1-L3']);
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
  assert.equal(f.run('Find the module handling authentication', { adapter: true }), '');
  assert.equal(existsSync(join(f.root, 'grafly/.cache/session/gate-test.json')), true);
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
  writeFileSync(join(f.root, 'grafly/workspace.json'), JSON.stringify({ version: 1, children: [] }));
  for (const thread of ['thread-a', 'thread-b']) {
    const result = spawnSync(process.execPath, [shim, 'prompt'], { cwd: f.root,
      env: { ...process.env, USERPROFILE: f.root, HOME: f.root, GRAFLY_NO_AUTO_INDEX: '1' },
      input: JSON.stringify({ cwd: f.root, thread_id: thread, prompt: 'Inspect request scheduling.' }),
      encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(f.root, `grafly/.cache/session/${thread}.json`)), true);
  }
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
