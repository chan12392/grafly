import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildGraph } from '../dist/graph/build.js';
import { writeWorkspace } from '../dist/graph/workspace.js';
import { contextDirFor } from '../dist/context/node-file.js';

const entry = fileURLToPath(new URL('../dist/entry.js', import.meta.url));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GRAFLY_|GRAFT_|MC_)/i.test(key)));

function tempRoot(t) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-readonly-circuit-'));
    t.after(() => {
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(root.includes('grafly-readonly-circuit-'));
        rmSync(root, { recursive: true, force: true });
    });
    return root;
}
async function ambiguousRepo(repo) {
    mkdirSync(repo, { recursive: true });
    for (const name of ['a', 'b']) writeFileSync(join(repo, name + '.js'), 'export function helper() { return 1; }\n');
    writeFileSync(join(repo, 'main.js'), "import { helper } from './a.js';\nexport function main() { return helper(); }\n");
    assert.equal((await buildGraph(repo)).structuralErrors, 0);
}
function runner(root, cwd) {
    return (args, extra = {}) => {
        const r = spawnSync(process.execPath, [entry, ...args, '--no-refresh'], { cwd, encoding: 'utf8', windowsHide: true,
            timeout: 60000, env: { ...baseEnv, GRAFLY_NO_DAEMON: '1', DO_NOT_TRACK: '1',
                MC_LEARNING_HOME: join(root, 'mc-learning'), ...extra } });
        assert.equal(r.status, 0, r.stderr);
        return r;
    };
}
const bytes = path => existsSync(path) ? readFileSync(path).toString('base64') : null;

test('GRAFLY_READONLY=1 callers neither appends nor rotates the circuit log', async t => {
    const root = tempRoot(t), repo = join(root, 'repo');
    await ambiguousRepo(repo);
    const run = runner(root, repo);
    const log = join(contextDirFor(repo), 'circuit-log.jsonl');
    // Control: an ordinary ambiguous query records its judgment.
    run(['callers', 'helper']);
    const judged = readFileSync(log, 'utf8');
    assert.match(judged, /"type":"judge"/);
    // Push the log past the rotation threshold, keeping the recent judgment in the tail.
    writeFileSync(log, JSON.stringify({ type: 'pad', x: 'x'.repeat(1600 * 1024) }) + '\n' + judged);
    const before = bytes(log);
    // Ambiguous (judge record) and unique narrowing with history (narrow record).
    for (const args of [['callers', 'helper'], ['callers', 'helper', '--json'], ['callers', 'helper', '--in', 'a.js']])
        run(args, { GRAFLY_READONLY: '1' });
    assert.equal(bytes(log), before, 'read-only callers changed the circuit log');
    assert.equal(existsSync(log + '.1'), false, 'read-only callers rotated the circuit log');
    // Control: the same narrowing without read-only rotates and records navigation.
    run(['callers', 'helper', '--in', 'a.js']);
    assert.ok(existsSync(log + '.1'));
    assert.match(readFileSync(log, 'utf8'), /"type":"narrow"/);
});

test('GRAFLY_READONLY=1 workspace callers writes no child circuit log', async t => {
    const root = tempRoot(t), children = ['alpha', 'beta'];
    for (const child of children) await ambiguousRepo(join(root, child));
    writeWorkspace(root, { version: 1, children });
    const run = runner(root, root);
    const logs = children.map(child => join(contextDirFor(join(root, child)), 'circuit-log.jsonl'));
    for (const args of [['callers', 'helper'], ['callers', 'helper', '--json']]) run(args, { GRAFLY_READONLY: '1' });
    assert.deepEqual(logs.map(existsSync), [false, false]);
    run(['callers', 'helper']);
    assert.deepEqual(logs.map(existsSync), [true, true]);
});
