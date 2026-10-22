import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FILES_V3, sha256, syncRuntime, resolveRuntime, smokeTest } from '../dist/mc-runtime/runtime.js';
import { runLearning } from '../dist/mc-runtime/cli.js';
import { collectJudgment } from '../dist/mc-runtime/feedback.js';
import { recordLabel } from '../dist/circuit/feedback.js';
import { logCircuit } from '../dist/graph/traverse-cli.js';
import { FEATURE_KEYS } from '../dist/circuit/mc-channel.js';
import { executeCliRequest } from '../dist/search/cli-request.js';

function configured(t, real = false) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-mc-learning-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const keys = generateKeyPairSync('ed25519');
    const config = { url: 'https://release.invalid/mc-releases', token: 'x'.repeat(64), publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
        python: real ? process.env.GRAFLY_TEST_PYTHON : process.execPath, minimumVersion: '0.1.0' };
    writeFileSync(join(root, 'config.json'), JSON.stringify(config));
    const files = Object.fromEntries(FILES_V3.map(name => {
        const bytes = Buffer.from('# verified fixture\n');
        return [name, { data: bytes.toString('base64'), sha256: sha256(bytes) }];
    }));
    const channels = Object.fromEntries(['tool_output', 'symbol_disambiguation', 'patch_quality'].map(name => [name, { version: '0.2.0', tag: `channel/${name}/v0.2.0` }]));
    let bundle = { schema: 'mc.runtime.bundle.v1', version: '0.3.1', source: 'a'.repeat(40), runtime_api: 3, python_min: '3.11',
        provided_channels: ['tool_output', 'symbol_disambiguation', 'patch_quality'], channels, files };
    if (real) {
        const script = "import json,sys;from pathlib import Path;sys.path[:0]=[sys.argv[1],str(Path(sys.argv[1])/'scripts')];from morecoffee import __version__;from build_channel_release import build;print(json.dumps(build(__version__,False)))";
        const built = spawnSync(config.python, ['-I', '-B', '-c', script, process.env.GRAFLY_TEST_MC_SOURCE],
            { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 512 * 1024 });
        assert.equal(built.status, 0, built.stderr);
        bundle = JSON.parse(built.stdout);
    }
    const bytes = Buffer.from(JSON.stringify(bundle));
    const metadata = { schema: 'mc.runtime.release.v1', version: bundle.version, source: bundle.source, runtime_api: 3, python_min: '3.11',
        sequence: 4, provided_channels: bundle.provided_channels, channels: bundle.channels, bytes: bytes.length, sha256: sha256(bytes) };
    const payload = Buffer.from(JSON.stringify(metadata));
    const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') };
    const transport = async url => new Response(url.endsWith('/v1/stable') ? JSON.stringify(envelope) : bytes);
    return { root, config, transport };
}

function observation(root) {
    return { type: 'judge', ts: new Date().toISOString(), root, query: 'private query never exported',
        verdict: 'confident', top1: 'private/a.js#run', scores: [{ id: 'private/a.js#run', score: 2 }, { id: 'private/b.js#run', score: 1 }],
        features: ['private/a.js#run', 'private/b.js#run'].map((id, i) => ({ id, ...Object.fromEntries(FEATURE_KEYS.map(k => [k, k === 'exact_name' ? 1 - i : 0])) })) };
}

test('API3 resolver verifies bytes, ignores MC_ROOT, exposes no credentials, and writes no state', async t => {
    const f = configured(t);
    await syncRuntime(f.root, { transport: f.transport, smoke() {} });
    const before = readdirSync(f.root).sort();
    const active = readFileSync(join(f.root, 'active.json'), 'utf8');
    const result = resolveRuntime(f.root);
    assert.equal(result.status, 'ok'); assert.equal(result.metadata.runtime_api, 3);
    assert.equal(result.metadata.channels.patch_quality.version, '0.2.0');
    assert.ok(!JSON.stringify(result).includes(f.config.token));
    assert.ok(!JSON.stringify(result).includes('PUBLIC KEY'));
    assert.deepEqual(readdirSync(f.root).sort(), before);
    assert.equal(readFileSync(join(f.root, 'active.json'), 'utf8'), active);
    const cli = new URL('../dist/mc-runtime/cli.js', import.meta.url);
    const child = spawnSync(process.execPath, [fileURLToPath(cli), 'resolve'],
        { env: { ...process.env, GRAFLY_MC_RUNTIME_HOME: f.root, MC_ROOT: '/untrusted/development' }, encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).root, result.root);
    writeFileSync(join(result.root, 'morecoffee/adaptive.py'), 'tampered');
    assert.deepEqual(resolveRuntime(f.root), { schema: 'grafly.mc-runtime.resolution.v1', status: 'error', error: 'mc_managed_unavailable' });
});

test('unconfigured resolver gives a stable error without creating files', t => {
    const root = mkdtempSync(join(tmpdir(), 'grafly-mc-none-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.equal(resolveRuntime(root).error, 'mc_unconfigured');
    assert.deepEqual(readdirSync(root), []);
});

test('collection preserves observations, exports only explicit labels, and excludes raw private text', t => {
    const home = mkdtempSync(join(tmpdir(), 'grafly-feedback-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const env = { MC_LEARNING_HOME: home }, judgment = observation(home);
    assert.equal(collectJudgment(judgment, null, env), false);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ schema: 'mc.learning.config.v1', enabled: true }));
    assert.equal(collectJudgment(judgment, null, env), true);
    assert.equal(collectJudgment(judgment, { source: 'navigation', expected: judgment.top1, evidence: 'not a label' }, env), false);
    const explicit = { source: 'explicit', expected: judgment.top1, evidence: 'verified private source receipt' };
    assert.equal(collectJudgment(judgment, explicit, env), true);
    const rows = readdirSync(join(home, 'inbox')).map(file => {
        const bytes = readFileSync(join(home, 'inbox', file));
        assert.equal(sha256(bytes) + '.json', file);
        assert.ok(!bytes.includes(Buffer.from('private')));
        assert.ok(!bytes.includes(Buffer.from(home)));
        return JSON.parse(bytes);
    });
    assert.equal(rows.length, 2); assert.equal(rows.filter(r => r.outcome === null).length, 1);
    assert.equal(rows.find(r => r.outcome)?.outcome.method, 'explicit_review');
});

test('actual signed API3 package connects Grafly feedback to the MC database and bounded trainer',
    { skip: !process.env.GRAFLY_TEST_MC_SOURCE || !process.env.GRAFLY_TEST_PYTHON }, async t => {
    const f = configured(t, true);
    const home = join(f.root, 'learning'); mkdirSync(home);
    const previous = process.env.MC_LEARNING_HOME;
    process.env.MC_LEARNING_HOME = home;
    t.after(() => { if (previous === undefined) delete process.env.MC_LEARNING_HOME; else process.env.MC_LEARNING_HOME = previous; });
    await syncRuntime(f.root, { transport: f.transport, smoke: smokeTest });
    await runLearning('configure', f.root);
    const judgment = observation(f.root), log = join(f.root, 'circuit.jsonl');
    const jid = logCircuit(log, judgment);
    const first = await runLearning('cycle', f.root);
    assert.equal(first.accepted, 1); assert.equal(first.observations, 1);
    assert.equal(first.tasks.symbol_disambiguation.labeled, 0);
    recordLabel(log, f.root, jid, judgment.top1, 'checked the exact declaration and caller');
    const second = await runLearning('cycle', f.root);
    assert.equal(second.observations, 1); assert.equal(second.tasks.symbol_disambiguation.labeled, 1);
    const status = await runLearning('status', f.root);
    assert.equal(status.enabled, true); assert.equal(status.models.symbol_disambiguation, null);
    const selected = resolveRuntime(f.root);
    const path = join(selected.root, 'bundle.json'), bundle = JSON.parse(readFileSync(path));
    bundle.channels.patch_quality.version = bundle.channels.patch_quality.version === '0.2.0' ? '0.2.1' : '0.2.0';
    writeFileSync(path, JSON.stringify(bundle));
    assert.throws(() => smokeTest(selected.root, f.config.python), /mc_smoke_quality_contract/);
});

test('resident callers use the model activated since the previous request',
    { skip: !process.env.GRAFLY_TEST_MC_SOURCE || !process.env.GRAFLY_TEST_PYTHON }, async t => {
    const f = configured(t, true), home = join(f.root, 'learning'), repo = join(f.root, 'repo');
    mkdirSync(home); mkdirSync(repo); mkdirSync(join(home, 'models'));
    const keys = ['GRAFLY_MC_RUNTIME_HOME', 'MC_LEARNING_HOME', 'GRAFLY_WEIGHTS', 'MC_ROOT'];
    const prior = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    t.after(() => { for (const k of keys) prior[k] === undefined ? delete process.env[k] : process.env[k] = prior[k]; });
    process.env.GRAFLY_MC_RUNTIME_HOME = f.root; process.env.MC_LEARNING_HOME = home;
    delete process.env.GRAFLY_WEIGHTS; delete process.env.MC_ROOT;
    await syncRuntime(f.root, { transport: f.transport, smoke: smokeTest });
    await runLearning('configure', f.root);
    for (const name of ['a', 'b']) writeFileSync(join(repo, name + '.js'), 'export function choose() {}');
    const build = await executeCliRequest({ command: 'build', argv: ['build', '.'], cwd: repo });
    assert.equal(build.exitCode, 0, build.stderr);
    const request = { command: 'callers', argv: ['callers', 'choose', '--json'], cwd: repo };
    const first = await executeCliRequest(request);
    assert.equal(first.exitCode, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).circuit.model_sha256, null);
    const weights = JSON.parse(readFileSync(new URL('../dist/circuit/mc/symbol_disambiguation.json', import.meta.url))).weights;
    const activate = delta => {
        const model = { schema: 'mc.learned.v1', policy: 'mc.grouped-fresh-audit.v1', task: 'symbol_disambiguation',
            approved: true, abstain_gap: 0.5, bias: 0, weights: { ...weights, exact_name: weights.exact_name + delta } };
        const bytes = Buffer.from(JSON.stringify(model)), digest = sha256(bytes);
        writeFileSync(join(home, 'models', digest + '.json'), bytes);
        writeFileSync(join(home, 'active.json'), JSON.stringify({ schema: 'mc.learning.active.v1', models: { symbol_disambiguation: digest } }));
        return digest;
    };
    for (const delta of [0.01, 0.02]) {
        const expected = activate(delta), result = await executeCliRequest(request);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).circuit.model_sha256, expected);
    }
});
