import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readGraph, wiringPath } from '../dist/graph/write.js';

test('stdio requests inherit executable lookup, accept overrides and restore it for the next request', t => {
    const root = mkdtempSync(join(tmpdir(), 'grafly-resident-env-'));
    t.after(() => {
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(root.includes('grafly-resident-env-'));
        rmSync(root, { recursive: true, force: true });
    });
    const home = join(root, 'service'), emptyPath = join(root, 'empty-path');
    mkdirSync(home); mkdirSync(emptyPath);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ xerjUrl: null }));
    const repos = ['inherited', 'overridden', 'restored'].map(name => {
        const cwd = join(root, name);
        mkdirSync(cwd);
        const git = spawnSync('git', ['init', '--quiet'], { cwd, encoding: 'utf8', windowsHide: true });
        assert.equal(git.status, 0, git.stderr);
        writeFileSync(join(cwd, '.gitignore'), 'private.js\n.grafly/\n');
        writeFileSync(join(cwd, 'public.js'), 'export function publicSymbol() {}');
        writeFileSync(join(cwd, 'private.js'), 'export function privateSymbol() {}');
        return cwd;
    });
    const requests = repos.map((cwd, i) => ({ id: i + 1, command: 'build', argv: ['build', '.'], cwd,
        ...(i === 1 ? { env: { PATH: emptyPath, PATHEXT: '.EXE' } } : {}) }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GRAFLY_|GRAFT_)/i.test(key)));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/entry.js', import.meta.url)), 'serve', '--stdio'], {
        cwd: root, env: { ...env, GRAFLY_SEARCH_HOME: home, HOME: root, USERPROFILE: root }, windowsHide: true,
        encoding: 'utf8', timeout: 120000, input: requests.map(r => JSON.stringify(r)).join('\n') + '\n',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    for (let i = 0; i < repos.length; i++) {
        const response = responses.find(row => row.id === i + 1);
        assert.equal(response?.exitCode, 0, JSON.stringify(response));
        const paths = [...new Set(readGraph(wiringPath(join(repos[i], '.grafly'))).nodes.map(n => n.path))].sort();
        assert.deepEqual(paths, i === 1 ? ['private.js', 'public.js'] : ['public.js']);
    }
});
