import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildGraph } from '../dist/graph/build.js';
import { writeWorkspace } from '../dist/graph/workspace.js';
import { grepGraph } from '../dist/search/grep.js';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-refresh-search-audit-'));
    t.after(() => {
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        rmSync(root, { recursive: true, force: true });
    });
    return root;
}

test('workspace queries report partial refresh errors alongside healthy children', async t => {
    const root = fixture(t);
    for (const child of ['bad', 'good']) mkdirSync(join(root, child));
    writeFileSync(join(root, 'bad', 'a.cs'), 'class Original {}');
    writeFileSync(join(root, 'good', 'b.js'), 'export function surviving() { return 1; }');
    for (const child of ['bad', 'good']) await buildGraph(join(root, child), { graphOnly: true });
    writeWorkspace(root, { version: 1, children: ['bad', 'good'] });
    writeFileSync(join(root, 'bad', 'a.cs'), 'class Changed {}');
    writeFileSync(join(root, 'good', 'b.js'), 'export function surviving() { return 2; }');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GRAFLY|GRAFT)_/i.test(key)));
    const result = spawnSync(process.execPath, [
        '--import', new URL('fixtures/wasm-failure.mjs', import.meta.url).href,
        fileURLToPath(new URL('../dist/entry.js', import.meta.url)), 'grep', 'surviving', root, '--fixed', '--json',
    ], { env: { ...env, GRAFLY_NO_DAEMON: '1' }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).totalHits, 1);
    assert.match(result.stderr, /bad: graph refresh incomplete: 1 structural error/);
    assert.match(result.stderr, /refreshed bad, good/);
});

test('grep reads only indexed paths that resolve within the checkout', t => {
    const root = fixture(t), repo = join(root, 'repo'), outside = join(root, 'outside');
    mkdirSync(repo); mkdirSync(outside);
    writeFileSync(join(repo, 'safe.js'), 'const sentinel = "inside";');
    writeFileSync(join(outside, 'secret.js'), 'const sentinel = "outside";');
    symlinkSync(outside, join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(repo, join(root, 'repo-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const paths = ['safe.js', '../outside/secret.js', join(outside, 'secret.js'), 'linked/secret.js'];
    const graph = { nodes: paths.map(path => ({ id: path, name: path, kind: 'file', path, span: 'L1-L1' })), edges: [] };
    for (const checkout of [repo, join(root, 'repo-alias')]) {
        const result = grepGraph(graph, checkout, 'sentinel', { fixed: true });
        assert.equal(result.totalHits, 1);
        assert.deepEqual(result.groups.map(group => group.path), ['safe.js']);
        assert.equal(result.truncated.files, 3);
        assert.equal(result.filesSearched, 4);
    }
});
