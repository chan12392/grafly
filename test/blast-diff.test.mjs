import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { changedFiles } from '../dist/blast/diff.js';

test('blast keeps added increment lines, later hunks and the next file', t => {
    const root = mkdtempSync(join(tmpdir(), 'grafly-blast-'));
    t.after(() => {
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        rmSync(root, { recursive: true, force: true });
    });
    const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.name', 'Grafly test');
    git('config', 'user.email', 'grafly@example.invalid');
    git('config', 'core.autocrlf', 'false');
    const before = 'let count = 0;\ncount += 1;\n\n\n\n\n\n\n\n\nfunction final() { return 1; }\n';
    writeFileSync(join(root, 'counter.js'), before);
    writeFileSync(join(root, 'other.js'), 'export const other = 1;\n');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline');
    writeFileSync(join(root, 'counter.js'), before.replace('count += 1;', '++ count;').replace('return 1;', 'return 2;'));
    writeFileSync(join(root, 'other.js'), 'export const other = 2;\n');

    const { files } = changedFiles(root);
    const counter = files.find(file => file.path === 'counter.js');
    assert.deepEqual(counter.ranges, [{ start: 2, end: 2 }, { start: 11, end: 11 }]);
    assert.deepEqual(counter.hunks[0].lines.find(line => line.sign === '+'), { n: 2, sign: '+', text: '++ count;' });
    assert.equal(counter.hunks[1].lines.at(-1).text, 'function final() { return 2; }');
    assert.deepEqual(files.find(file => file.path === 'other.js').ranges, [{ start: 1, end: 1 }]);
});
