import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runInit } from '../dist/claude/init.js';
import { runRetract } from '../dist/hosts/retract.js';
import { mergeGraftSettings, mergeGraftHooks } from '../dist/claude/settings-merge.js';
import { promptAskTimeout, postEditCheckTimeout } from '../dist/claude/hooks.js';
import { buildGraph } from '../dist/graph/build.js';
import { checkGraph } from '../dist/graph/check.js';
import { probeDrift, fingerprintPath } from '../dist/graph/fingerprint.js';
import { ensureFreshGraph } from '../dist/graph/refresh.js';
import { readExtractCache } from '../dist/graph/extract-cache.js';
import { readGraph, wiringPath } from '../dist/graph/write.js';
import { contextDirFor } from '../dist/context/node-file.js';
import { warmGenericGrammars, swapGrammarForTest, extractGeneric } from '../dist/graph/generic.js';
import { writeWorkspace, readWorkspace } from '../dist/graph/workspace.js';
import { executeCliRequest } from '../dist/search/cli-request.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const NATIVE = fileURLToPath(new URL('fixtures/native-unavailable.cjs', import.meta.url));
const FAILURE = new URL('fixtures/wasm-failure.mjs', import.meta.url).href;
const SYNC = fileURLToPath(new URL('../dist/claude/sync-run.js', import.meta.url));
const temp = () => mkdtempSync(join(tmpdir(), 'grafly-upstream-'));
function put(root, path, value) {
    const dest = join(root, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, value);
    return dest;
}
function node(args, cwd, env = {}) {
    const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true,
        timeout: 120000, env: { ...process.env, GRAFLY_NO_DAEMON: '1', ...env } });
    assert.ifError(result.error);
    return result;
}
const graph = root => readGraph(wiringPath(contextDirFor(root)));
const command = (name, timeout) => ({ type: 'command', command: `node ".claude/helpers/grafly-hooks.cjs" ${name}`, timeout });

test('init refuses malformed settings before any writes; retract requires explicit apply', () => {
    for (const bad of ['{broken', '[]', 'null', '"settings"']) {
        const root = temp(), home = temp();
        const path = put(root, '.claude/settings.json', bad);
        assert.throws(() => runInit(root, { build: false, home }), /not a readable JSON object/);
        assert.equal(readFileSync(path, 'utf8'), bad);
        assert.deepEqual(readdirSync(join(root, '.claude')), ['settings.json']);
        assert.deepEqual(readdirSync(home), []);
    }
    const root = temp();
    put(root, '.claude/settings.json', JSON.stringify({ custom: true }));
    runInit(root, { build: false, global: false });
    const settings = join(root, '.claude/settings.json');
    const before = readFileSync(settings, 'utf8');
    for (const apply of [undefined, false]) {
        runRetract(root, { apply, global: false, cache: false });
        assert.equal(readFileSync(settings, 'utf8'), before);
        assert.ok(existsSync(join(root, '.claude/helpers/grafly-hooks.cjs')));
    }
    runRetract(root, { apply: true, global: false, cache: false });
    assert.equal(JSON.parse(readFileSync(settings)).custom, true);
    assert.ok(!existsSync(join(root, '.claude/helpers/grafly-hooks.cjs')));
});

test('Claude hook timeouts use seconds, preserve deliberate raises and retain foreign handlers', () => {
    const foreign = { type: 'command', command: 'other-hook', timeout: 99 };
    const prior = { hooks: { UserPromptSubmit: [{ matcher: 'custom', hooks: [command('prompt', 30), foreign] }],
        PostToolUse: [{ hooks: [command('post-edit', 10000)] }] } };
    for (const merged of [mergeGraftSettings(prior).merged, mergeGraftHooks(prior, '/helpers').merged]) {
        const prompt = merged.hooks.UserPromptSubmit.flatMap(b => b.hooks);
        assert.equal(prompt.find(h => h.command.endsWith(' prompt')).timeout, 30);
        assert.deepEqual(prompt.find(h => h.command === 'other-hook'), foreign);
        assert.equal(merged.hooks.PostToolUse.flatMap(b => b.hooks).find(h => h.command.endsWith(' post-edit')).timeout, 10);
        assert.equal(merged.hooks.Stop[0].hooks[0].timeout, 8);
    }
    const root = temp(), config = temp();
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
        for (const [timeout, expected] of [[8, 6000], [15, 13000], [8000, 6000], [3, 2500], [0.1, 1]]) {
            put(root, '.claude/settings.json', JSON.stringify({ hooks: {
                UserPromptSubmit: [{ hooks: [command('prompt', timeout)] }],
                PostToolUse: [{ hooks: [command('post-edit', 10), command('tool-savings', 1)] }],
            } }));
            assert.equal(promptAskTimeout(root), expected);
            assert.equal(postEditCheckTimeout(root), 8000);
        }
        put(config, 'settings.json', JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [command('prompt', 2)] }] } }));
        put(root, '.claude/settings.local.json', JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [command('prompt', 1)] }] } }));
        put(root, '.claude/settings.json', JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [command('prompt', 15)] }] } }));
        assert.equal(promptAskTimeout(root), 500); // local settings are the tightest budget
    }
    finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
    }
});

test('WASM trees are freed after success or query failure; parser recovers and failed cache retries', async () => {
    await warmGenericGrammars(['rust']);
    const original = swapGrammarForTest('rust', null);
    let deleted = 0, resets = 0, parses = 0;
    const parser = { parse(input) {
        parses++;
        const tree = original.parser.parse(input);
        const free = tree.delete.bind(tree);
        tree.delete = () => { deleted++; free(); };
        return tree;
    }, reset() { resets++; original.parser.reset(); } };
    try {
        swapGrammarForTest('rust', { ...original, parser });
        assert.ok(extractGeneric('a.rs', 'fn sample() {}', 'rust').nodes.some(n => n.name === 'sample'));
        swapGrammarForTest('rust', { ...original, parser, query: { matches() { throw new Error('bad query'); } } });
        assert.throws(() => extractGeneric('a.rs', 'fn sample() {}', 'rust'), /bad query/);
        assert.equal(deleted, 2);
        const root = temp();
        put(root, 'a.rs', 'fn recovered() {}');
        swapGrammarForTest('rust', { ...original, parser: { parse() { throw new Error('transient'); }, reset() { resets++; } } });
        const failed = await buildGraph(root, { graphOnly: true });
        assert.equal(failed.structuralErrors, 1);
        swapGrammarForTest('rust', { ...original, parser });
        const retry = await buildGraph(root, { graphOnly: true });
        assert.equal(retry.structuralErrors, 0);
        assert.equal(retry.parsed, 1);
        assert.ok(graph(root).nodes.some(n => n.name === 'recovered'));
        assert.equal(resets, 1);
        assert.equal(parses, 3);
    }
    finally { swapGrammarForTest('rust', original); }
});

test('extension selection stays consistent through build, check, drift, refresh and extractor upgrades', async () => {
    const root = temp();
    put(root, 'a.go', 'package main\nfunc Kept() {}\n');
    put(root, 'b.js', 'export function ignored() {}\n');
    const first = await buildGraph(root, { graphOnly: true, extensions: ['GO', '.go'] });
    assert.equal(first.files, 1);
    assert.deepEqual(graph(root).meta.extensions, ['.go']);
    assert.equal((await checkGraph(root)).ok, true);
    put(root, 'new.js', 'export function alsoIgnored() {}');
    assert.deepEqual(probeDrift(root, first.contextDir), { changed: [], added: [], removed: [] });
    put(root, 'a.go', 'package main\nfunc Changed() {}\n');
    assert.equal((await checkGraph(root)).ok, false);
    assert.equal((await ensureFreshGraph(root)).refreshed, true);
    assert.ok(graph(root).nodes.every(n => n.path.endsWith('.go')));
    assert.equal((await checkGraph(root)).ok, true);
    const fingerprint = fingerprintPath(first.contextDir);
    renameSync(fingerprint, `${fingerprint}.previous`);
    assert.equal((await ensureFreshGraph(root)).refreshed, true);
    assert.deepEqual(graph(root).meta.extensions, ['.go']);
    const all = await buildGraph(root, { graphOnly: true });
    assert.equal(all.files, 3);
    assert.equal(graph(root).meta.extensions, undefined);
});

test('missing native grammar uses WASM in build/check/container; recovery invalidates cached stand-ins', () => {
    const root = temp();
    put(root, 'a.py', 'def rescued():\n    return 1\n');
    put(root, 'b.ts', 'export function typed(): number { return 1; }\n');
    put(root, 'c.vue', '<template><div/></template>\n<script lang="ts">\nexport function component() {}\n</script>\n');
    const env = { GRAFLY_TEST_MISSING_NATIVE: 'tree-sitter' };
    const oneMissing = node(['--require', NATIVE, CLI, 'build', '.'], root, { GRAFLY_TEST_MISSING_NATIVE: 'tree-sitter-python' });
    assert.equal(oneMissing.status, 0, oneMissing.stderr);
    assert.match(oneMissing.stderr, /tree-sitter-python/);
    const built = node(['--require', NATIVE, CLI, 'build', '.'], root, env);
    assert.equal(built.status, 0, built.stderr);
    assert.match(built.stderr, /basic WASM parsing/);
    assert.ok(graph(root).nodes.some(n => n.name === 'rescued'));
    assert.ok(graph(root).nodes.some(n => n.name === 'typed'));
    const component = graph(root).nodes.find(n => n.name === 'component');
    assert.equal(component.span, 'L3-L3');
    assert.equal(node(['--require', NATIVE, CLI, 'check', '.', '--json'], root, env).status, 0);
    assert.equal(readExtractCache(contextDirFor(root)).files['a.py'].via, 'wasm:python');
    const restored = node([CLI, 'build', '.'], root);
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, /parsed: 3 of 3/);
    assert.equal(readExtractCache(contextDirFor(root)).files['a.py'].via, undefined);
});

test('structural CLI failures retain healthy output, exit 1 and continue workspace siblings', () => {
    const root = temp();
    put(root, 'a.cs', 'class Broken {}');
    put(root, 'b.js', 'export function healthy() {}');
    const result = node(['--import', FAILURE, CLI, 'build', '.', '--allow-partial'], root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /wiring incomplete/);
    assert.doesNotMatch(result.stdout, /✓ wiring:/);
    assert.ok(graph(root).nodes.some(n => n.name === 'healthy'));
    const workspace = temp();
    for (const child of ['bad', 'good']) mkdirSync(join(workspace, child, '.git'), { recursive: true });
    put(workspace, 'bad/a.cs', 'class Broken {}');
    put(workspace, 'good/b.js', 'export function surviving() {}');
    const built = node(['--import', FAILURE, CLI, 'build', '.'], workspace);
    assert.equal(built.status, 1, built.stderr);
    assert.match(built.stderr, /workspace build incomplete/);
    assert.deepEqual(readWorkspace(workspace).children, ['bad', 'good']);
    assert.ok(graph(join(workspace, 'good')).nodes.some(n => n.name === 'surviving'));
});

test('CLI and workspace extension filters reach background sync without leaking parent override', () => {
    const workspace = temp();
    for (const child of ['one', 'two']) {
        mkdirSync(join(workspace, child, '.git'), { recursive: true });
        put(workspace, `${child}/a.go`, 'package main\nfunc Selected() {}');
        put(workspace, `${child}/b.js`, 'export function excluded() {}');
    }
    const built = node([CLI, 'build', '.', '--extensions', 'GO'], workspace);
    assert.equal(built.status, 0, built.stderr);
    for (const child of ['one', 'two']) assert.deepEqual(graph(join(workspace, child)).meta.extensions, ['.go']);
    // Different selections on children must survive a background workspace rebuild.
    assert.equal(node([CLI, 'build', '.', '--extensions', '.js'], join(workspace, 'two')).status, 0);
    const override = join(workspace, 'parent-index');
    writeWorkspace(workspace, { version: 1, children: ['one', 'two'] }, override);
    const receipt = join(temp(), 'args.jsonl');
    const stub = put(temp(), 'cli.cjs', `require('node:fs').appendFileSync(process.env.RECEIPT, JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2),dir:process.env.GRAFLY_DIR,legacy:process.env.GRAFT_DIR})+'\\n');`);
    const sync = node([SYNC, workspace], workspace, { GRAFLY_DIR: override, GRAFT_DIR: override, GRAFLY_TEST_CLI: stub, RECEIPT: receipt });
    assert.equal(sync.status, 0, sync.stderr);
    const rows = readFileSync(receipt, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(r => r.argv), [['build', '.', '--extensions', '.go'], ['build', '.', '--extensions', '.js']]);
    assert.ok(rows.every(r => r.dir === undefined && r.legacy === undefined));
    const singleReceipt = join(temp(), 'single.jsonl');
    const single = node([SYNC, join(workspace, 'one')], workspace, { GRAFLY_TEST_CLI: stub, RECEIPT: singleReceipt });
    assert.equal(single.status, 0, single.stderr);
    assert.deepEqual(JSON.parse(readFileSync(singleReceipt, 'utf8')).argv, ['build', '.', '--extensions', '.go']);
});

test('a partial build ends only its resident CLI request', async () => {
    await warmGenericGrammars(['c_sharp']);
    const original = swapGrammarForTest('c_sharp', null);
    const broken = temp(), healthy = temp();
    put(broken, 'a.cs', 'class Broken {}');
    put(healthy, 'a.js', 'export function stillAlive() {}');
    swapGrammarForTest('c_sharp', { ...original, parser: { parse() { throw new Error('request failure'); }, reset() {} } });
    try {
        const failed = await executeCliRequest({ argv: ['build', '.'], cwd: broken });
        assert.equal(failed.exitCode, 1);
        assert.match(failed.stderr, /wiring incomplete/);
        const next = await executeCliRequest({ argv: ['build', '.'], cwd: healthy });
        assert.equal(next.exitCode, 0, next.stderr);
        assert.ok(graph(healthy).nodes.some(n => n.name === 'stillAlive'));
    }
    finally { swapGrammarForTest('c_sharp', original); }
});
