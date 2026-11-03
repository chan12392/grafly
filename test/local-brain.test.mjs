import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { buildGraph } from '../dist/graph/build.js';
import { readGraph, wiringPath } from '../dist/graph/write.js';
import { readLink, readRulesCache, writeLink, writeRulesCache } from '../dist/brain/link.js';
import { addRules } from '../dist/brain/note.js';
import { buildLocalDigest } from '../dist/brain/push.js';
import { configureLocalBrain, localBrainState, mineLocalBrain, scheduleLocalBrain, MINING_INTERVAL_MS } from '../dist/brain/local.js';
import { executeSearch } from '../dist/search/request.js';

const cli = fileURLToPath(new URL('../dist/entry.js', import.meta.url));
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:GRAFLY|GRAFT|MC|OPENAI|ANTHROPIC|OPENROUTER|ORCAROUTER)_/i.test(key)));
function run(args, env = {}) {
    return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000,
        env: { ...cleanEnv(), GRAFLY_NO_DAEMON: '1', GRAFLY_JUDGMENT_CONFIG: '0', DO_NOT_TRACK: '1', ...env } });
}
async function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-local-brain-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'home', '.codex'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), '.grafly/\nhome/\n');
    writeFileSync(join(root, 'work.js'), 'export function work() { return 42; }\n');
    writeFileSync(join(root, 'AGENTS.md'), '# Project\nKeep the work contract stable.\n');
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Keep work deterministic for callers']]) {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
        assert.equal(result.status, 0, result.stderr);
    }
    await buildGraph(root);
    const graph = readGraph(wiringPath(join(root, '.grafly')));
    return { root, graph, symbol: graph.nodes.find(n => n.name === 'work'), home: join(root, 'home') };
}
const response = (symbol, rule = 'Keep work deterministic') => ({ text: JSON.stringify({ anchors: [{ symbol, rule, source: 'abcdef' }] }) });
async function waitFor(root, status) {
    for (let i = 0; i < 200; i++) {
        const state = localBrainState(root);
        if (state?.status === status) return state;
        if (['error', 'needs-model'].includes(state?.status)) assert.fail(JSON.stringify(state));
        await delay(100);
    }
    assert.fail(`Worker did not reach ${status}: ${JSON.stringify(localBrainState(root))}`);
}

test('local digest needs neither GitHub origin nor network and excludes generated rules', async t => {
    const f = await fixture(t);
    writeFileSync(join(f.root, 'AGENTS.md'), '# Project\nKeep the work contract stable.\n<!-- grafly:brain:start -->\nNever learn this generated rule\n<!-- grafly:brain:end -->\n');
    const built = await buildLocalDigest(f.root, f.graph, { fetchImpl: () => { throw new Error('must not fetch'); } });
    assert.ok(built.digest, built.error);
    assert.equal(built.digest.provider, 'local');
    assert.equal(built.digest.threads.length, 0);
    assert.ok(built.digest.symbols.some(s => s.id === f.symbol.id));
    assert.doesNotMatch(JSON.stringify(built.digest), /Never learn this generated rule/);
    const result = run(['brain', 'digest', f.root]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).provider, 'local');
});

test('remote-cache migration preserves notes and ignores old environment credentials', async t => {
    const f = await fixture(t);
    const old = { brainId: 'old', token: 'test-token', baseUrl: 'https://must-not-contact.invalid' };
    writeLink(f.root, old);
    writeRulesCache(f.root, { brainId: old.brainId, fetchedAt: 1,
        rules: [{ ruleId: 'old-rule', symbol: '', fingerprint: '', rule: 'Preserve old decisions' }] }, old);
    const env = { GRAFLY_BRAIN_ID: 'wrong', GRAFLY_BRAIN_TOKEN: 'wrong-token', GRAFLY_BRAIN_URL: 'https://must-not-contact.invalid' };
    const note = run(['brain', 'note', f.root, '--repo-wide', '--rule', 'Keep local notes'], env);
    assert.equal(note.status, 0, note.stderr);
    assert.equal(readLink(f.root).local, true);
    assert.equal(readLink(f.root).baseUrl, undefined);
    assert.deepEqual(readRulesCache(f.root).rules.map(r => r.rule), ['Preserve old decisions', 'Keep local notes']);
    const status = run(['brain', 'status', f.root, '--json'], env);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).mode, 'local');
    assert.doesNotMatch(status.stdout, /test-token|wrong-token/);
    configureLocalBrain(f.root, { background: false });
    assert.equal(readRulesCache(f.root).rules.length, 2);
});

test('mining merges concurrent notes, validates anchors and reuses an unchanged digest', async t => {
    const f = await fixture(t);
    configureLocalBrain(f.root, { background: true });
    let calls = 0;
    const model = { async create() {
        calls++;
        addRules(f.root, [{ rule: 'A concurrent local note', repoWide: true }], f.graph);
        return { text: JSON.stringify({ anchors: [{ symbol: f.symbol.id, rule: 'Keep work deterministic', source: 'abcdef', fingerprint: 'fake' },
            { symbol: 'missing', rule: 'Must be rejected' }] }) };
    } };
    const result = await mineLocalBrain(f.root, { model, home: f.home });
    assert.equal(result.status, 'complete', result.error);
    const rules = readRulesCache(f.root).rules;
    assert.equal(rules.length, 2);
    assert.equal(rules[1].fingerprint, f.symbol.body_hash);
    assert.equal(rules[1].sourceUrl, undefined);
    assert.match(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), /Keep work deterministic/);
    assert.equal((await mineLocalBrain(f.root, { background: true, model, home: f.home })).status, 'unchanged');
    assert.equal(calls, 1);
    const query = await executeSearch({ command: 'ask', query: 'work', dir: f.root,
        opts: { readOnly: true, refresh: false, xerj: false, json: true, source: true } });
    assert.equal(query.exitCode, 0, query.stderr);
    assert.match(query.stdout, /Keep work deterministic/);
});

test('overlapping mining is excluded and disabling discards an in-flight result', async t => {
    const f = await fixture(t);
    configureLocalBrain(f.root, { background: true });
    addRules(f.root, [{ rule: 'Keep this note', repoWide: true }], f.graph);
    let resolveModel, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const pending = mineLocalBrain(f.root, { home: f.home, model: { create() {
        entered(); return new Promise(resolve => { resolveModel = resolve; });
    } } });
    await started;
    assert.equal((await mineLocalBrain(f.root, { model: { create() { assert.fail('second model call'); } } })).status, 'busy');
    configureLocalBrain(f.root, { background: false });
    resolveModel(response(f.symbol.id));
    assert.equal((await pending).status, 'discarded');
    assert.deepEqual(readRulesCache(f.root).rules.map(r => r.rule), ['Keep this note']);
    assert.equal(localBrainState(f.root).status, 'disabled');
});

test('failed mining preserves rules and malformed cache migration preserves bytes', async t => {
    const f = await fixture(t);
    configureLocalBrain(f.root);
    addRules(f.root, [{ rule: 'Keep despite model failure', repoWide: true }], f.graph);
    const result = await mineLocalBrain(f.root, { home: f.home, model: { async create() { return { text: '{"anchors":null}' }; } } });
    assert.equal(result.status, 'error');
    assert.equal(result.exitCode, 1);
    assert.equal(readRulesCache(f.root).rules[0].rule, 'Keep despite model failure');
    const path = join(f.root, '.grafly', '.cache', 'brain-rules.json');
    writeFileSync(path, '{broken');
    assert.throws(() => configureLocalBrain(f.root, { background: true }), /cache was preserved/);
    assert.equal(readFileSync(path, 'utf8'), '{broken');
});

test('real background CLI mines through the user model, records completion, and respects read-only', async t => {
    const f = await fixture(t), requests = [];
    const server = createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk;
        requests.push({ url: req.url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: response(f.symbol.id).text } }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const enabled = run(['brain', 'enable', f.root], { GRAFLY_PROVIDER: 'openai', GRAFLY_API_KEY: 'fixture', GRAFLY_MODEL: 'fixture-model',
        GRAFLY_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` });
    assert.equal(enabled.status, 0, enabled.stderr);
    const complete = await waitFor(f.root, 'complete');
    assert.equal(complete.exitCode, 0);
    assert.ok(existsSync(complete.log));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v1/chat/completions');
    assert.equal(JSON.parse(requests[0].body).model, 'fixture-model');
    assert.match(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), /Keep work deterministic/);
    assert.equal(scheduleLocalBrain(f.root), false);
    const before = JSON.stringify(localBrainState(f.root));
    await executeSearch({ command: 'ask', query: 'work', dir: f.root, opts: { readOnly: true, xerj: false } });
    assert.equal(JSON.stringify(localBrainState(f.root)), before);
    assert.equal(scheduleLocalBrain(f.root, Date.now() + MINING_INTERVAL_MS + 1), true);
    await waitFor(f.root, 'unchanged');
    assert.equal(requests.length, 1);
    assert.equal(run(['brain', 'disable', f.root]).status, 0);
    assert.equal(readLink(f.root).background, false);
    assert.equal(readRulesCache(f.root).rules.length, 1);
});

test('missing models and retired remote commands have actionable outcomes', async t => {
    const f = await fixture(t);
    const result = run(['brain', 'mine', f.root], { GRAFLY_AMBIENT_URL: 'http://127.0.0.1:1/v1' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(localBrainState(f.root).status, 'needs-model');
    const help = run(['brain', '--help']);
    assert.equal(help.status, 0, help.stderr);
    for (const name of ['enable', 'disable', 'mine', 'note', 'digest', 'status']) assert.match(help.stdout, new RegExp(`\\b${name}\\b`));
    assert.doesNotMatch(help.stdout, /^\s+(?:connect|push|pull)(?:\s|\[|\()/m);
    const out = join(f.root, 'forbidden.json');
    assert.equal(run(['--read-only', 'brain', 'digest', f.root, '--out', out]).status, 1);
    assert.equal(existsSync(out), false);
});
