import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const shim = fileURLToPath(new URL('../scripts/grafly-devin-hook.cjs', import.meta.url));
const { claimStartup } = createRequire(import.meta.url)(shim);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'grafly-startup-dedup-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'grafly'));
  writeFileSync(join(root, 'grafly/workspace.json'), JSON.stringify({ version: 1, children: ['project/a'] }));
  return root;
}

test('duplicate startup emits once; sessions, context changes and resume remain available', t => {
  const root = fixture(t);
  assert.equal(claimStartup(root, { session_id: 'one' }, 'orientation'), true);
  assert.equal(claimStartup(root, { session_id: 'one' }, 'orientation'), false);
  assert.equal(claimStartup(root, { thread_id: 'two' }, 'orientation'), true);
  assert.equal(claimStartup(root, { session_id: 'one' }, 'new index list'), true);
  for (const source of ['resume', 'compact', 'clear']) {
    assert.equal(claimStartup(root, { session_id: 'one', source }, 'orientation'), true);
    assert.equal(claimStartup(root, { session_id: 'one', source }, 'orientation'), true);
  }
});

test('later startup and inaccessible cache fail open', t => {
  const root = fixture(t);
  assert.equal(claimStartup(root, { session_id: 'one' }, 'orientation'), true);
  const dir = join(root, 'grafly/.cache/hook-startup');
  const stamp = join(dir, readdirSync(dir)[0]);
  // Real NTFS timestamps can be fractionally ahead of integer Date.now().
  const clock = Math.floor(statSync(stamp).mtimeMs);
  assert.equal(claimStartup(root, { session_id: 'one' }, 'orientation', clock), false);
  utimesSync(stamp, new Date(0), new Date(0));
  assert.equal(claimStartup(root, { session_id: 'one' }, 'orientation'), true);
  const blocked = join(root, 'not-a-directory');
  writeFileSync(blocked, 'original');
  assert.equal(claimStartup(blocked, { session_id: 'one' }, 'orientation'), true);
});

test('real adapter deduplicates two concurrent registrations without changing orientation', async t => {
  const root = fixture(t);
  const env = { ...process.env, USERPROFILE: root, HOME: root, GRAFLY_NO_AUTO_INDEX: '1', GRAFLY_NO_SELF_UPDATE: '1' };
  const input = JSON.stringify({ cwd: root, session_id: 'concurrent', source: 'startup' });
  const run = () => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [shim, 'session-start'],
      { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { error += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 && !error ? resolveRun(output) : reject(new Error(error || `exit ${code}`)));
    child.stdin.end(input);
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(results.filter(Boolean).length, 1);
  const orientation = JSON.parse(results.find(Boolean)).hookSpecificOutput;
  assert.equal(orientation.hookEventName, 'SessionStart');
  assert.match(orientation.additionalContext, /Projects: project\/a/);
  assert.match(orientation.additionalContext, /--source --no-refresh/);
  const resume = spawnSync(process.execPath, [shim, 'session-start'],
    { cwd: root, env, windowsHide: true, encoding: 'utf8',
      input: JSON.stringify({ cwd: root, session_id: 'concurrent', source: 'resume' }) });
  assert.equal(resume.status, 0, resume.stderr);
  assert.equal(JSON.parse(resume.stdout).hookSpecificOutput.additionalContext, orientation.additionalContext);
});
