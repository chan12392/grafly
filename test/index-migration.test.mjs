import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { contextDirFor } from '../dist/context/node-file.js';
import { migrateIndex } from '../dist/context/migrate-index.js';
import { archiveIndex } from '../dist/context/archive-index.js';
import { acquireLockIn, releaseLockIn } from '../dist/util/state.js';
import { buildGraph } from '../dist/graph/build.js';
import { writeCards } from '../dist/graph/cards.js';
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-migrate-'));
    t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
    const put = (name, text) => { const p = join(root, name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
    return { root, put };
}
test('ordinary grafly project directory is not an index', t => {
    const { root, put } = fixture(t); put('grafly/package.json', '{}');
    assert.equal(contextDirFor(root), join(root, '.grafly'));
    assert.equal(migrateIndex(root).status, 'unchanged');
    assert.ok(existsSync(join(root, 'grafly/package.json')));
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

test('ordinary builds preserve migration and archived notes while pruning retired cards', async t => {
    const { root, put } = fixture(t);
    put('src/keep.js', 'export const keep = 1;');
    put('src/retired.js', 'export const retired = 2;');
    assert.deepEqual((await buildGraph(root, { contextDir: join(root, 'grafly') })).errors, []);
    const notes = '---\nslug: retired-concept\nsources: []\n---\n<!-- context:generated:start -->\nOld concept.\n<!-- context:generated:end -->\nOnly saved human rollback notes.\n';
    put('grafly/retired-concept.md', notes);
    put('grafly/.cache/nested/notes.md', 'Nested original human notes.\n');
    const migrated = migrateIndex(root);
    assert.equal(migrated.status, 'migrated');
    const index = join(root, '.grafly');
    assert.equal(archiveIndex(index), 'removed');
    assert.equal(existsSync(join(index, 'retired-concept.md')), false);
    const history = join(index, '.index-history');
    const backups = [join(history, readdirSync(history)[0]), join(migrated.backup, 'index')];
    const preserved = backups.flatMap(backup => [join(backup, 'retired-concept.md'), join(backup, '.cache/nested/notes.md')]);
    preserved.push(join(migrated.backup, 'index/src/retired.md'), join(migrated.backup, 'receipt.json'));
    const bytes = preserved.map(file => readFileSync(file));
    const emptyDirs = backups.map(backup => join(backup, 'empty/nested'));
    for (const dir of emptyDirs) mkdirSync(dir, { recursive: true });
    assert.ok(existsSync(join(index, 'src/retired.md')));
    rmSync(join(root, 'src/retired.js'));
    for (let build = 0; build < 2; build++) {
        const result = await buildGraph(root);
        assert.deepEqual(result.errors, []);
        assert.equal(result.cards, 1);
        assert.ok(existsSync(join(index, 'src/keep.md')));
        assert.equal(existsSync(join(index, 'src/retired.md')), false);
        preserved.forEach((file, i) => assert.deepEqual(readFileSync(file), bytes[i], file));
        emptyDirs.forEach(dir => assert.ok(existsSync(dir), dir));
    }
});

test('card pruning preserves empty storage roots and still owns nested source cards', t => {
    const { root, put } = fixture(t), index = join(root, '.grafly');
    const storage = ['.cache', '.graph', '.index-history', '.migration-backups'];
    for (const dir of storage) mkdirSync(join(index, dir), { recursive: true });
    for (const dir of ['.index-history', '.migration-backups']) put(`.grafly/src/${dir}/retired.md`, '# Retired source card\n');
    assert.equal(writeCards({ nodes: [], edges: [] }, index).pruned, 2);
    for (const dir of storage) assert.ok(existsSync(join(index, dir)), dir);
    assert.equal(existsSync(join(index, 'src')), false);
});
