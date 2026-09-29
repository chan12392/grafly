import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { contextDirFor } from '../dist/context/node-file.js';
import { migrateIndex } from '../dist/context/migrate-index.js';
import { archiveIndex } from '../dist/context/archive-index.js';
import { acquireLockIn, releaseLockIn } from '../dist/util/state.js';
import { hasGraflyIndex, hasGraftIndex, nearestGraflyRoot, nearestGraftRoot } from '../dist/graph/root.js';
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-migrate-'));
    t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
    const put = (name, text) => { const p = join(root, name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
    return { root, put };
}
test('ordinary grafly project directory is not an index', t => {
    const { root, put } = fixture(t); put('grafly/package.json', '{}');
    put('.grafly/config.json', '{}');
    assert.equal(contextDirFor(root), join(root, '.grafly'));
    assert.equal(hasGraflyIndex(root), false);
    assert.equal(migrateIndex(root).status, 'unchanged');
    assert.ok(existsSync(join(root, 'grafly/package.json')));
});
test('root discovery preserves graph, workspace and legacy index locations', t => {
    const { root, put } = fixture(t);
    for (const name of ['.grafly', 'grafly', 'graft']) {
        for (const marker of ['.graph/wiring.json', 'workspace.json']) {
            const group = `${name}-${marker === 'workspace.json' ? 'workspace' : 'graph'}`;
            const project = join(root, group), nested = join(project, 'code', 'nested');
            put(`${group}/${name}/${marker}`, '{}');
            mkdirSync(nested, { recursive: true });
            assert.equal(contextDirFor(project), join(project, name));
            assert.equal(hasGraflyIndex(project), true);
            assert.equal(hasGraflyIndex(nested), false);
            assert.deepEqual(nearestGraflyRoot(nested), { root: project, levels: 2 });
            assert.deepEqual(nearestGraflyRoot(nested, 'custom-index'), { root: nested, levels: 0 });
        }
    }
    assert.equal(hasGraftIndex, hasGraflyIndex);
    assert.equal(nearestGraftRoot, nearestGraflyRoot);
});
test('migration preserves settings, every original byte, and supports repeated invocation', t => {
    const { root, put } = fixture(t);
    put('grafly/.graph/wiring.json', '{"nodes":[]}'); put('grafly/notes.md', 'personal note');
    put('.grafly/config.json', '{"includeDirs":["dist"]}'); put('.grafly/mc-runtime/config.json', 'private fixture');
    assert.equal(contextDirFor(root), join(root, 'grafly'));
    assert.equal(migrateIndex(root, { dryRun: true }).status, 'planned');
    assert.equal(existsSync(join(root, '.grafly/.graph')), false);
    const result = migrateIndex(root);
    assert.equal(result.status, 'migrated');
    assert.equal(readFileSync(join(root, '.grafly/notes.md'), 'utf8'), 'personal note');
    assert.equal(readFileSync(join(result.backup, 'index/notes.md'), 'utf8'), 'personal note');
    assert.equal(readFileSync(join(root, '.grafly/config.json'), 'utf8'), '{"includeDirs":["dist"]}');
    assert.equal(migrateIndex(root).status, 'unchanged');
    archiveIndex(join(root, '.grafly'));
    assert.equal(existsSync(join(root, '.grafly/.graph')), false);
    assert.equal(readFileSync(join(root, '.grafly/mc-runtime/config.json'), 'utf8'), 'private fixture');
    assert.equal(readFileSync(join(root, '.grafly/notes.md'), 'utf8'), 'personal note');
});
test('conflicts, active writers and linked backups preserve both sides', t => {
    const { root, put } = fixture(t);
    put('grafly/.graph/wiring.json', 'old'); put('.grafly/.graph/wiring.json', 'new');
    assert.throws(() => migrateIndex(root), /conflict/);
    assert.equal(readFileSync(join(root, 'grafly/.graph/wiring.json'), 'utf8'), 'old');
    put('.grafly/.graph/wiring.json', 'old');
    const lock = join(root, 'grafly/.cache'); assert.ok(acquireLockIn(lock));
    try { assert.throws(() => migrateIndex(root), /active index writer/); } finally { releaseLockIn(lock); }
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), join(root, '.grafly/.migration-backups'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => migrateIndex(root), /linked/);
});
