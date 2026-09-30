import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ask } from '../dist/ask/ask.js';
import { writeGraph } from '../dist/graph/write.js';
import { cacheKey } from '../dist/ask/answer-cache.js';

const CLI = resolve('dist/cli.js');
const outsideMarker = 'synthetic private content outside the repo';
function fixture(t) {
    const base = mkdtempSync(join(tmpdir(), 'grafly-source-boundary-'));
    t.after(() => {
        assert.ok(resolve(base).startsWith(resolve(tmpdir()) + sep));
        rmSync(base, { recursive: true, force: true });
    });
    const root = join(base, 'repo');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'safe.js'), 'export function getUserName() { return "safe"; }\n');
    mkdirSync(join(base, 'repo-private'));
    writeFileSync(join(base, 'repo-private', 'secret.js'), outsideMarker + '\n');
    return { base, root };
}
function index(root, path) {
    writeGraph({ version: 1, meta: {}, edges: [], nodes: [{
        id: 'getUserName', name: 'getUserName', kind: 'function', path,
        span: 'L1-L1', signature: 'function getUserName()',
    }] }, join(root, '.grafly'));
}

for (const kind of ['parent path', 'absolute path', 'external link']) {
    test(`ask --source never reads an indexed ${kind} outside the repo`, t => {
        const { base, root } = fixture(t);
        let pointer = '../repo-private/secret.js';
        if (kind === 'absolute path') pointer = join(base, 'repo-private', 'secret.js');
        if (kind === 'external link') {
            symlinkSync(join(base, 'repo-private'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
            pointer = 'linked/secret.js';
        }
        index(root, pointer);
        for (const full of [false, true]) {
            const result = ask(root, 'getUserName', { source: true, full });
            assert.ok(result.hits.length);
            assert.equal(result.hits[0].code, undefined);
            assert.ok(!JSON.stringify(result).includes(outsideMarker));
        }
        const result = spawnSync(process.execPath, [CLI, 'ask', 'getUserName', '--source', '--json', '--no-refresh'], {
            cwd: root, encoding: 'utf8', windowsHide: true,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(!result.stdout.includes(outsideMarker));
        assert.ok(!readFileSync(join(root, '.grafly', '.cache', 'answers.json'), 'utf8').includes(outsideMarker));
    });
}

test('ask allows source and directory links that resolve inside the repo', t => {
    const { base, root } = fixture(t);
    symlinkSync(join(root, 'src'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(root, join(base, 'repo-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    index(root, 'linked/safe.js');
    for (const dir of [root, join(base, 'repo-alias')]) {
        assert.match(ask(dir, 'getUserName', { source: true }).hits[0].code, /return "safe"/);
    }
});

test('CLI discards pre-boundary cached answers instead of replaying outside content', t => {
    const { root } = fixture(t);
    index(root, 'src/safe.js');
    const cache = join(root, '.grafly', '.cache', 'answers.json');
    mkdirSync(join(root, '.grafly', '.cache'), { recursive: true });
    const key = cacheKey('getUserName', { limit: '8', source: true, json: true }, root);
    writeFileSync(cache, JSON.stringify({ version: 3, entries: {
        [key]: { text: outsideMarker, stamp: {}, ts: Date.now() },
    } }));
    const result = spawnSync(process.execPath, [CLI, 'ask', 'getUserName', '--source', '--json', '--no-refresh'], {
        cwd: root, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(outsideMarker));
    assert.doesNotMatch(result.stderr, /answer cache hit/);
    assert.ok(!readFileSync(cache, 'utf8').includes(outsideMarker));
});
