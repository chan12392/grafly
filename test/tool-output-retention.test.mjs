import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, truncateSync,
  readdirSync, linkSync, symlinkSync, renameSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { ARCHIVE_BUDGET, startArchive, finishArchive, pruneArchives, startArchiveMaintenance } from '../dist/tool-output/retention.js';
import { runCommand, readOutput } from '../dist/tool-output/runner.js';

const MiB = 1024 * 1024;
const fixtures = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'grafly-retention-')); fixtures.push(root); return root; };
after(() => {
  for (const root of fixtures) {
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(target.startsWith(join(resolve(tmpdir()), 'grafly-retention-')));
    rmSync(target, { recursive: true, force: true }); // only roots minted by this test process
  }
});
function record(root, size, day = 1, { active = false, pid = process.pid, manifest = true } = {}) {
  const id = randomUUID(), dir = join(root, id);
  mkdirSync(dir);
  writeFileSync(join(dir, 'stdout.bin'), ''); truncateSync(join(dir, 'stdout.bin'), size);
  writeFileSync(join(dir, 'stderr.bin'), '');
  const started_at = `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  if (manifest) writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 'grafly.tool-output.v1', id, started_at }));
  if (active) {
    startArchive(dir, id);
    const owner = JSON.parse(readFileSync(join(dir, '.active.json'), 'utf8'));
    writeFileSync(join(dir, '.active.json'), JSON.stringify({ ...owner, pid, started_at }));
  }
  return { id, dir };
}
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(10); }
  assert.fail('condition did not become true');
}

test('20 MiB total budget, dry-run, oldest-first deletion and clear expired lookup', () => {
  const root = fixture();
  const a = record(root, 8 * MiB, 1), b = record(root, 8 * MiB, 2), c = record(root, 8 * MiB, 3);
  assert.equal(ARCHIVE_BUDGET, 20 * MiB);
  const preview = pruneArchives({ root, dryRun: true });
  assert.deepEqual(preview.candidates, [a.id]); assert.equal(preview.deleted.length, 0);
  assert.ok(existsSync(a.dir));
  const result = pruneArchives({ root });
  assert.deepEqual(result.deleted, [a.id]); assert.ok(result.bytes_after <= ARCHIVE_BUDGET);
  assert.ok(existsSync(b.dir) && existsSync(c.dir));
  assert.throws(() => readOutput(a.id, { archiveDir: root }), /expired under the 20 MiB/);
});

test('quiet active writers stay protected even with a manifest and over 20 MiB; finish permits cleanup', () => {
  const root = fixture();
  const active = record(root, 21 * MiB, 1, { active: true });
  const old = record(root, MiB, 2);
  const result = pruneArchives({ root });
  assert.deepEqual(result.deleted, [old.id]); assert.ok(result.over_budget);
  assert.ok(existsSync(active.dir)); assert.ok(result.protected_bytes > ARCHIVE_BUDGET);
  finishArchive(active.dir, active.id);
  assert.deepEqual(pruneArchives({ root }).deleted, [active.id]);
});

test('background sweep reclaims a crashed writer without another command', async () => {
  const root = fixture();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  await once(child, 'spawn');
  const active = record(root, 21 * MiB, 1, { active: true, pid: child.pid, manifest: false });
  const stop = startArchiveMaintenance(root, 20);
  try {
    assert.ok(existsSync(active.dir));
    const exited = once(child, 'exit'); child.kill(); await exited;
    await until(() => !existsSync(active.dir));
  } finally { stop(); child.kill(); }
});

test('real runner exceeds quota while alive, preserves stdout once, then reclaims the completed archive', async () => {
  const root = fixture(), release = join(root, 'release');
  let outputBytes = 0, stderr = '';
  const script = "const fs=require('node:fs');process.stdout.write(Buffer.alloc(21*1024*1024,120));"
    + "const t=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(t);process.exit(0)}},10)";
  const run = runCommand(process.execPath, ['-e', script, release], { archiveDir: root,
    stdout: { write(b) { outputBytes += b.length; } }, stderr: { write(b) { stderr += b.toString(); } } });
  try {
    await until(() => outputBytes === 21 * MiB);
    const live = pruneArchives({ root });
    assert.ok(live.over_budget); assert.equal(live.deleted.length, 0);
  } finally { writeFileSync(release, 'done'); }
  const result = await run;
  assert.equal(result.exit_code, 0); assert.equal(outputBytes, 21 * MiB); assert.equal(result.archive, null);
  assert.match(stderr, /raw archive expired/); assert.ok(!existsSync(join(root, result.id)));
});

test('unknown children, hard links, malformed owners and legacy partials are protected', () => {
  const root = fixture();
  const unknown = record(root, 7 * MiB, 1); writeFileSync(join(unknown.dir, 'user-note.txt'), 'keep');
  const hard = record(root, 7 * MiB, 2); linkSync(join(hard.dir, 'stdout.bin'), join(root, 'external-link'));
  const partial = record(root, 7 * MiB, 3, { manifest: false });
  const malformed = record(root, MiB, 4, { active: true }); writeFileSync(join(malformed.dir, '.active.json'), '{');
  const ordinary = record(root, MiB, 5);
  const result = pruneArchives({ root });
  assert.deepEqual(result.deleted, [ordinary.id]); assert.ok(result.over_budget);
  for (const item of [unknown, hard, partial, malformed]) assert.ok(existsSync(item.dir));
});

test('junction roots and linked record directories are not traversed or deleted', () => {
  const parent = fixture(), outside = fixture();
  const external = record(outside, 21 * MiB);
  const rootLink = join(parent, 'root-link');
  symlinkSync(outside, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(pruneArchives({ root: rootLink }).status, 'unavailable');
  const root = fixture();
  symlinkSync(external.dir, join(root, randomUUID()), process.platform === 'win32' ? 'junction' : 'dir');
  pruneArchives({ root });
  assert.ok(existsSync(external.dir));
});

test('live cleanup lock serializes sweeps; a dead lock owner is recovered', () => {
  const root = fixture(), a = record(root, 21 * MiB);
  writeFileSync(join(root, '.retention.lock'), JSON.stringify({ pid: process.pid, token: 'live' }));
  assert.equal(pruneArchives({ root }).status, 'busy'); assert.ok(existsSync(a.dir));
  const ended = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(ended.status, 0);
  writeFileSync(join(root, '.retention.lock'), JSON.stringify({ pid: ended.pid, token: 'dead' }));
  assert.deepEqual(pruneArchives({ root }).deleted, [a.id]);
});

test('an interrupted claimed deletion is retried even below the budget', () => {
  const root = fixture(), a = record(root, 100);
  renameSync(a.dir, join(root, '.gc-' + a.id));
  assert.deepEqual(pruneArchives({ root }).deleted, [a.id]);
  assert.deepEqual(readdirSync(root), []);
});

test('public and lightweight CLIs share dry-run and pruning behavior', () => {
  for (const relative of ['../dist/cli.js', '../dist/tool-output/cli.js']) {
    const root = fixture(), a = record(root, 21 * MiB);
    const cli = fileURLToPath(new URL(relative, import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [cli, 'output-prune', ...args], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, GRAFLY_OUTPUT_DIR: root } });
    const preview = run('--dry-run'); assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(JSON.parse(preview.stdout).candidates, [a.id]); assert.ok(existsSync(a.dir));
    const applied = run(); assert.equal(applied.status, 0, applied.stderr);
    assert.deepEqual(JSON.parse(applied.stdout).deleted, [a.id]); assert.ok(!existsSync(a.dir));
  }
});
