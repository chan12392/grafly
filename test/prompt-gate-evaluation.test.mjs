import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { shouldRetrievePrompt } from '../dist/claude/prompt-gate.js';
const corpus = JSON.parse(readFileSync(new URL('./fixtures/prompt-gate-evaluation.json', import.meta.url), 'utf8'));
for (const group of corpus.groups.filter(group => group.expect !== 'observe')) {
  test(`challenge set: ${group.name} (${group.prompts.length} cases)`, () => {
    const failures = group.prompts.filter(prompt => shouldRetrievePrompt(prompt) !== (group.expect === 'retrieve'));
    assert.deepEqual(failures, [], 'Misclassified prompts');
  });
}

test('a conversation prefix/suffix cannot suppress an attached code task (192 variations)', () => {
  const chats = ['Thanks!', '좋아요.', 'Can Grafly save tokens?', 'Which tools do you use most often?'];
  const tasks = ['Profile memory allocation.', '캐시를 붙여줘.', 'App.vue', '401', 'Inspect request scheduling.', '로그인 오류', 'Optimize the startup path.', 'a+b'];
  for (const chat of chats) for (const task of tasks) for (const delimiter of [' ', '\n', '\n\n']) {
    assert.equal(shouldRetrievePrompt(chat + delimiter + task), true, chat + delimiter + task);
    assert.equal(shouldRetrievePrompt(task + delimiter + chat), true, task + delimiter + chat);
  }
});

test('large and punctuation-heavy payloads finish within a child-process timeout', () => {
  const url = new URL('../dist/claude/prompt-gate.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { shouldRetrievePrompt } = await import(${JSON.stringify(url)});
    assert.equal(shouldRetrievePrompt('x'.repeat(250000) + '('), true);
    assert.equal(shouldRetrievePrompt('Thanks! '.repeat(10000)), false);
    assert.equal(shouldRetrievePrompt('Thanks! '.repeat(10000) + 'Profile memory allocation.'), true);
    assert.equal(shouldRetrievePrompt('Can Grafly save tokens? '.repeat(5000) + 'App.vue'), true);
  `], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
