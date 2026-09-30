import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSync } from '../dist/claude/sync-run.js';
import { main as hookMain } from '../dist/claude/hooks.js';
import { acquireLock, patchStats, readStats, resolveContextDir } from '../dist/claude/state.js';

const syncScript = fileURLToPath(new URL('../dist/claude/sync-run.js', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const runtime = process.env.GRAFLY_TEST_SYNC_NODE || process.execPath;

function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'grafly-sync hidden-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const keys = ['GRAFLY_DIR', 'GRAFT_DIR', 'GRAFLY_TEST_CLI', 'GRAFT_TEST_CLI'];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    t.after(() => {
        for (const key of keys) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });
    patchStats(dir, { dirty: true, syncing: true });
    assert.equal(acquireLock(dir), true);
    return dir;
}

test('sync build hides its child and preserves cwd, arguments and lock release', t => {
    const dir = fixture(t);
    process.env.GRAFLY_DIR = 'custom index';
    process.env.GRAFLY_TEST_CLI = cli;
    // Move fixture state to the configured index, as a real hook would.
    patchStats(dir, { dirty: true, syncing: true });
    assert.equal(acquireLock(dir), true);
    const graphDir = join(resolveContextDir(dir), '.graph');
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(graphDir, 'wiring.json'), JSON.stringify({ nodes: [], edges: [] }));
    const calls = [];
    t.mock.method(childProcess, 'execFileSync', (...args) => { calls.push(args); });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    runSync(dir);
    assert.equal(calls.length, 1);
    const [file, args, options] = calls[0];
    assert.equal(file, process.execPath);
    assert.deepEqual(args, [cli, 'build', '.', '--dir', resolveContextDir(dir)]);
    assert.equal(options.cwd, dir);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 120000);
    assert.equal(readStats(dir).dirty, false);
    assert.equal(readStats(dir).syncing, false);
    assert.equal(existsSync(join(resolveContextDir(dir), '.cache', '.sync.lock')), false);
});

test('native sync worker rebuilds a graph and clears dirty state', t => {
    const dir = fixture(t);
    writeFileSync(join(dir, 'app.js'), 'export function hiddenSyncFixture() { return 42; }\n');
    const result = spawnSync(runtime, [syncScript, dir], {
        cwd: dir, env: { ...process.env, GRAFLY_TEST_CLI: cli },
        windowsHide: true, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const graph = JSON.parse(readFileSync(join(resolveContextDir(dir), '.graph', 'wiring.json'), 'utf8'));
    assert.ok(graph.nodes.some(node => node.name === 'hiddenSyncFixture'));
    assert.equal(readStats(dir).dirty, false);
    assert.equal(readStats(dir).syncing, false);
    assert.ok(readStats(dir).syncedAt);
    assert.equal(existsSync(join(resolveContextDir(dir), '.cache', '.sync.lock')), false);
    t.diagnostic(`sync worker and build child verified with ${runtime}`);
});

test('prompt retrieval hides its CLI child without changing query arguments', async t => {
    const dir = fixture(t);
    const savedStdin = process.env.GRAFLY_TEST_STDIN;
    const savedProject = process.env.CLAUDE_PROJECT_DIR;
    process.env.GRAFLY_TEST_STDIN = JSON.stringify({ cwd: dir, prompt: 'hiddenSyncFixture' });
    delete process.env.CLAUDE_PROJECT_DIR;
    process.env.GRAFLY_TEST_CLI = cli;
    t.after(() => {
        if (savedStdin === undefined) delete process.env.GRAFLY_TEST_STDIN;
        else process.env.GRAFLY_TEST_STDIN = savedStdin;
        if (savedProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = savedProject;
    });
    const calls = [];
    t.mock.method(childProcess, 'execFileSync', (...args) => { calls.push(args); return '{}'; });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await hookMain('prompt');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], [cli, 'ask', 'hiddenSyncFixture', '.', '--json', '-n', '3']);
    assert.equal(calls[0][2].cwd, dir);
    assert.equal(calls[0][2].windowsHide, true);
});

test('failed native build keeps dirty state for retry and releases the lock', t => {
    const dir = fixture(t);
    const failCli = join(dir, 'failing-cli.cjs');
    writeFileSync(failCli, 'process.exit(23);\n');
    const result = spawnSync(runtime, [syncScript, dir], {
        cwd: dir, env: { ...process.env, GRAFLY_TEST_CLI: failCli },
        windowsHide: true, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readStats(dir).dirty, true);
    assert.equal(readStats(dir).syncing, false);
    assert.equal(existsSync(join(resolveContextDir(dir), '.cache', '.sync.lock')), false);
});
