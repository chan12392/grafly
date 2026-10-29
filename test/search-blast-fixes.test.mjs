import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { grepGraph } from '../dist/search/grep.js';
import { blastRadius } from '../dist/blast/blast.js';
import { changedFiles } from '../dist/blast/diff.js';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-fixes-'));
    t.after(() => {
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        rmSync(root, { recursive: true, force: true });
    });
    return root;
}

test('grep line anchors match in CRLF files', t => {
    const root = fixture(t);
    writeFileSync(join(root, 'a.js'), 'function done() {\r\n  return 1;\r\n}\r\n');
    const graph = {
        nodes: [
            { id: 'a.js', name: 'a.js', kind: 'file', path: 'a.js', span: 'L1-L3' },
            { id: 'a.js#done', name: 'done', kind: 'function', path: 'a.js', span: 'L1-L3' },
        ],
        edges: [],
    };
    const result = grepGraph(graph, root, '1;$');
    assert.equal(result.totalHits, 1);
    assert.equal(result.groups[0].symbol.name, 'done');
    assert.equal(result.groups[0].hits[0].text, 'return 1;');
});

test('blast keeps both symbols when two spans are identical', () => {
    const graph = {
        nodes: [
            { id: 'a.js', name: 'a.js', kind: 'file', path: 'a.js', span: 'L1-L5' },
            { id: 'a.js#x', name: 'x', kind: 'function', path: 'a.js', span: 'L2-L4' },
            { id: 'a.js#y', name: 'y', kind: 'variable', path: 'a.js', span: 'L2-L4' },
        ],
        edges: [],
    };
    const report = blastRadius(graph, [{ path: 'a.js', status: 'modified', ranges: [{ start: 3, end: 3 }], hunks: [] }], 'test', { depth: 1 });
    assert.deepEqual(report.seeds.map(s => s.name).sort(), ['x', 'y']);
});

test('blast diff paths are relative to an index root below the git top level', t => {
    const root = fixture(t), sub = join(root, 'pkg');
    mkdirSync(sub);
    const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.name', 'Grafly test');
    git('config', 'user.email', 'grafly@example.invalid');
    writeFileSync(join(sub, 'a.js'), 'export const a = 1;\n');
    writeFileSync(join(root, 'outside.js'), 'export const o = 1;\n');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline');
    writeFileSync(join(sub, 'a.js'), 'export const a = 2;\n');
    writeFileSync(join(root, 'outside.js'), 'export const o = 2;\n');
    const { files } = changedFiles(sub);
    assert.deepEqual(files.map(f => f.path), ['a.js']);
});
