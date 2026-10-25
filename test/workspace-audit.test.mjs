import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildGraph } from '../dist/graph/build.js';
import { ask } from '../dist/ask/ask.js';
import { federateAsk, federateAskAsync, writeWorkspace } from '../dist/graph/workspace.js';

const root = mkdtempSync(join(tmpdir(), 'grafly-workspace-audit-'));
const children = ['alpha', 'beta'];
const path = 'src space/worker.js';
const entry = fileURLToPath(new URL('../dist/entry.js', import.meta.url));
before(async () => {
    for (const child of children) {
        const repo = join(root, child);
        mkdirSync(join(repo, 'src space'), { recursive: true });
        writeFileSync(join(repo, path), 'export function targetTask() { return 1; }\n' +
            'export function invokeTask() { return targetTask(); }\n' +
            'export function secondTask() { return targetTask(); }\n');
        writeFileSync(join(repo, 'main.js'), "import fs from 'node:fs';\nimport { targetTask } from './src space/worker.js';\n");
        const built = await buildGraph(repo);
        assert.equal(built.structuralErrors, 0);
    }
    writeWorkspace(root, { version: 1, children });
});
after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes('grafly-workspace-audit-'));
    rmSync(root, { recursive: true, force: true });
});
function cli(...args) {
    return spawnSync(process.execPath, [entry, ...args, '--no-refresh'], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
        env: { ...process.env, GRAFLY_NO_DAEMON: '1', GRAFLY_CIRCUIT_LOG: '0', GRAFLY_MC: '0' },
    });
}

test('workspace structural answers retain each child order and qualified source pointers', async () => {
    const query = 'who calls targetTask';
    const expected = children.map(child => ask(join(root, child), query).hits.map(hit => `${child}/${hit.pointer}`));
    assert.equal(expected[0].length, 2);
    for (const result of [federateAsk(root, undefined, query), await federateAskAsync(root, undefined, query, { xerj: false })]) {
        assert.equal(result.mode, 'structural');
        assert.deepEqual(result.hits.map(hit => hit.pointer), [expected[0][0], expected[1][0], expected[0][1], expected[1][1]]);
        assert.ok(result.hits.every(hit => hit.kind === 'caller'));
    }
});

test('workspace structural imports qualify source spans and preserve external module names', async () => {
    const query = 'what does main.js import';
    const single = ask(join(root, 'alpha'), query);
    assert.deepEqual(single.hits.map(hit => hit.pointer).sort(), ['node:fs', `${path}:L1-L4`].sort());
    const fromCli = cli('ask', query, '--json', '--no-xerj');
    assert.equal(fromCli.status, 0, fromCli.stderr);
    for (const result of [federateAsk(root, undefined, query),
        await federateAskAsync(root, undefined, query, { xerj: false }), JSON.parse(fromCli.stdout)]) {
        assert.equal(result.mode, 'structural');
        assert.deepEqual(result.hits.map(hit => hit.pointer).sort(),
            ['node:fs', 'node:fs', ...children.map(child => `${child}/${path}:L1-L4`)].sort());
    }
});

test('workspace exact matches in paths with spaces remain separate across children', async () => {
    for (const fileTopLock of [true, false]) {
        for (const result of [federateAsk(root, undefined, 'targetTask', { fileTopLock }),
            await federateAskAsync(root, undefined, 'targetTask', { fileTopLock, xerj: false })]) {
            const exact = result.hits.filter(hit => hit.exactSymbol);
            assert.deepEqual(exact.map(hit => hit.pointer), children.map(child => `${child}/${path}:L1-L1`));
        }
    }
});

test('workspace explicit child scopes retain missing-prefix errors', async () => {
    const opts = { in: 'alpha/does-not-exist', xerj: false };
    assert.throws(() => federateAsk(root, undefined, 'targetTask', opts), /nothing indexed/);
    await assert.rejects(federateAskAsync(root, undefined, 'targetTask', opts), /nothing indexed/);
    assert.ok(federateAsk(root, undefined, 'targetTask', { in: 'alpha/src space' }).hits.every(hit => hit.scope.startsWith('alpha')));
    const missing = cli('ask', 'targetTask', '--in', opts.in, '--no-xerj');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /nothing indexed/);
});

test('workspace callers supports JSON and caps every matched symbol in text and JSON', () => {
    const text = cli('callers', 'targetTask', '--limit', '1');
    assert.equal(text.status, 0, text.stderr);
    assert.equal((text.stdout.match(/calls ←/g) ?? []).length, 2);
    assert.equal((text.stdout.match(/\+1 more callers/g) ?? []).length, 2);
    const json = cli('callers', 'targetTask', '--limit', '1', '--json');
    assert.equal(json.status, 0, json.stderr);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.query, 'targetTask');
    assert.deepEqual(payload.repos.map(repo => repo.repo), children);
    for (const repo of payload.repos) {
        assert.equal(repo.matches[0].symbol.name, 'targetTask');
        assert.equal(repo.matches[0].hits.length, 1);
        assert.equal(repo.matches[0].hitOverflow, 1);
    }
    const all = cli('callers', 'targetTask', '--limit', 'all', '--json', '--in', 'alpha');
    assert.equal(all.status, 0, all.stderr);
    assert.equal(JSON.parse(all.stdout).repos[0].matches[0].hits.length, 2);
});

test('workspace callers rejects invalid direction and depth like a single repository', () => {
    for (const [flag, value] of [['--direction', 'SIDEWAYS'], ['--depth', 'oops'], ['--depth', '0']]) {
        const result = cli('callers', 'targetTask', flag, value);
        assert.equal(result.status, 1, result.stdout);
        assert.match(result.stderr, new RegExp(`${flag} must be`));
    }
    const out = cli('callers', 'invokeTask', '--direction', 'out', '--depth', 'all', '--json');
    assert.equal(out.status, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).repos[0].matches[0].hits[0].name, 'targetTask');
});

test('workspace callers defaults to 100 hits and accepts an explicit unlimited walk', async () => {
    const repo = join(root, 'alpha');
    writeFileSync(join(repo, 'hub.js'), 'export function hubTarget() {}\n' +
        Array.from({ length: 102 }, (_, i) => `export function user${i}() { hubTarget(); }`).join('\n'));
    await buildGraph(repo);
    const capped = cli('callers', 'hubTarget', '--json');
    assert.equal(capped.status, 0, capped.stderr);
    const match = JSON.parse(capped.stdout).repos[0].matches[0];
    assert.equal(match.hits.length, 100);
    assert.equal(match.hitOverflow, 2);
    const all = cli('callers', 'hubTarget', '--limit', '0', '--json');
    assert.equal(all.status, 0, all.stderr);
    assert.equal(JSON.parse(all.stdout).repos[0].matches[0].hits.length, 102);
});

test('workspace callers exposes dropped calls and bare-name references in both output formats', async () => {
    const repo = join(root, 'alpha');
    for (const file of ['left.js', 'right.js']) writeFileSync(join(repo, file),
        'export function sharedTask() {}\nexport class SharedBase {}\n');
    writeFileSync(join(repo, 'ambiguous.js'),
        'export function ambiguousUser() { sharedTask(); }\nexport class Derived extends SharedBase {}\n');
    await buildGraph(repo);
    for (const [query, field, warning] of [
        ['sharedTask', 'ambiguousCalls', /dropped as ambiguous.*undercount/],
        ['SharedBase', 'unresolvedNameRefs', /bare name.*attribution unknown/],
    ]) {
        const json = cli('callers', query, '--json');
        assert.equal(json.status, 0, json.stderr);
        const result = JSON.parse(json.stdout).repos[0];
        assert.equal(result[field].length, 1);
        const single = cli('callers', query, repo, '--json');
        assert.equal(single.status, 0, single.stderr);
        assert.deepEqual(result[field], JSON.parse(single.stdout)[field]);
        assert.match(result.limitations.join('\n'), warning);
        const text = cli('callers', query);
        assert.equal(text.status, 0, text.stderr);
        assert.match(text.stdout, warning);
        const out = cli('callers', query, '--direction', 'out', '--json');
        assert.equal(out.status, 0, out.stderr);
        assert.equal(JSON.parse(out.stdout).repos[0][field], undefined);
    }
});
