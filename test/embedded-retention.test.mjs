import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { embeddedBinding, pruneEmbedded } from '../dist/search/embedded.js';
import { syncXerj, xerjStatePath } from '../dist/search/xerj.js';
import { contextDirFor } from '../dist/context/node-file.js';
import { lock } from '../dist/util/retention.js';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-embedded-retention-'));
    t.after(() => {
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(root.includes('grafly-embedded-retention-'));
        rmSync(root, { recursive: true, force: true });
    });
    return root;
}

test('embedded retention keeps current/previous generations and refuses foreign files and links', t => {
    const root = fixture(t), cache = join(root, '.cache', 'xerj');
    mkdirSync(cache, { recursive: true });
    const index = `grafly-${'a'.repeat(20)}-${'b'.repeat(20)}`;
    function generation(prefix = index) {
        const name = `${prefix}-${randomUUID()}`, path = join(cache, name);
        mkdirSync(path);
        writeFileSync(join(path, 'ids.json'), '[]');
        return name;
    }
    const old = generation(), current = generation(), previous = generation();
    const foreign = generation(`grafly-${'c'.repeat(20)}-${'b'.repeat(20)}`);
    const unknown = generation(); writeFileSync(join(cache, unknown, 'user.txt'), 'keep');
    const hardlink = generation(); linkSync(join(cache, hardlink, 'ids.json'), join(root, 'linked-ids.json'));
    const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'ids.json'), '["keep"]');
    const link = `${index}-${randomUUID()}`;
    symlinkSync(outside, join(cache, link), process.platform === 'win32' ? 'junction' : 'dir');
    const lease = lock(cache);
    assert.ok(lease);
    try { pruneEmbedded(root, { index, directory: current, previousDirectory: previous }); }
    finally { lease.release(); }
    assert.ok(!existsSync(join(cache, old)));
    for (const name of [current, previous, foreign, unknown, hardlink, link]) assert.ok(existsSync(join(cache, name)), name);
    assert.equal(readFileSync(join(outside, 'ids.json'), 'utf8'), '["keep"]');
    // A linked cache root must not be followed even when its children look owned.
    const linkedRoot = join(root, 'linked'); mkdirSync(linkedRoot);
    symlinkSync(join(root, '.cache'), join(linkedRoot, '.cache'), process.platform === 'win32' ? 'junction' : 'dir');
    pruneEmbedded(linkedRoot, { index, directory: 'absent' });
    assert.ok(existsSync(join(cache, current)));
});

test('native sync prunes generations, preserves live readers and leaves the manifest intact on failure', { timeout: 120000 }, async t => {
    try { embeddedBinding(); } catch (error) { t.skip(error.message); return; }
    const root = fixture(t), outDir = contextDirFor(root), cache = join(outDir, '.cache', 'xerj');
    const entry = fileURLToPath(new URL('fixtures/embedded-sync.mjs', import.meta.url));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GRAFLY_|GRAFT_)/i.test(key)));
    function sync(action = 'build') {
        const result = spawnSync(process.execPath, [entry, root, action], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
        assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout.trim());
    }
    writeFileSync(join(root, 'sample.js'), 'export function markerzero() { return "first"; }');
    const first = sync();
    const child = spawn(process.execPath, [entry, root, 'reader'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = once(child, 'exit');
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    try {
        assert.deepEqual(await once(lines, 'line'), ['ready']);
        writeFileSync(join(root, 'sample.js'), 'export function markerone() { return "second"; }');
        const second = sync();
        writeFileSync(join(root, 'sample.js'), 'export function markertwo() { return "third"; }');
        const third = sync();
        assert.equal(third.previousDirectory, second.directory);
        assert.notEqual(first.directory, third.directory);
        for (const state of [second, third]) assert.ok(existsSync(join(cache, state.directory)));
        const response = once(lines, 'line'); child.stdin.write('markerzero\n');
        assert.ok(JSON.parse((await response)[0]).some(id => id.includes('markerzero')));
        child.stdin.end(); await exit;
        const repeated = sync('sync');
        assert.equal(repeated.directory, third.directory);
        assert.equal(repeated.previousDirectory, second.directory);
        assert.deepEqual(readdirSync(cache).sort(), [second.directory, third.directory].sort());
        const manifest = readFileSync(xerjStatePath(outDir), 'utf8');
        const lease = lock(cache);
        assert.ok(lease);
        try { await assert.rejects(syncXerj(root, outDir, 'embedded'), /cache is busy/); }
        finally { lease.release(); }
        let checks = 0;
        await assert.rejects(syncXerj(root, outDir, 'embedded', { signal: { throwIfAborted() {
            if (++checks === 2) throw new Error('abort before publication');
        } } }), /abort before publication/);
        assert.equal(readFileSync(xerjStatePath(outDir), 'utf8'), manifest);
        assert.ok(existsSync(join(cache, second.directory)));
        assert.ok(!existsSync(join(cache, '.retention.lock')));
    } finally {
        lines.close();
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await exit; }
    }
});
