import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { observeComparison, outputItems } from '../dist/mc-runtime/comparison.js';
import { FILES_V3, FILES_V4, verifyBundle, sha256 } from '../dist/mc-runtime/runtime.js';

function configuration(t, port) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-comparison-'));
    t.after(() => rmSync(root, { force: true, recursive: true }));
    const config = { schema: 'grafly.comparison.v1', enabled: true, service_root: join(root, 'broker'),
        runtime_root: join(root, 'runtime'), state_root: join(root, 'state'), python: process.execPath };
    mkdirSync(config.service_root);
    mkdirSync(join(config.state_root, 'model-access'), { recursive: true });
    writeFileSync(join(config.state_root, 'model-access', 'settings.json'), JSON.stringify({ mode: 'both' }));
    const source = join(config.runtime_root, 'releases', 'a'.repeat(40), 'src', 'beakho_harness');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'mc_comparison.py'), '# fixture\n');
    writeFileSync(join(config.runtime_root, 'state.json'), JSON.stringify({ active: 'a'.repeat(40) }));
    writeFileSync(join(config.service_root, 'service.json'), JSON.stringify({ state: 'running', protocol: 1,
        capabilities: ['background-jobs-v1'], token: 'fixture-private-token', port }));
    const file = join(root, 'comparison.json');
    writeFileSync(file, JSON.stringify(config));
    return { root, config, env: { GRAFLY_JUDGMENT_CONFIG: file, CODEX_THREAD_ID: 'fixture-thread' } };
}
const event = text => ({ task: 'input_block_retention', items: [{ id: 'last', text, protected: false, constraint_status: 'unknown' }] });

test('no configuration means no background activity', async () => {
    assert.equal((await observeComparison(event('body'), { env: { GRAFLY_JUDGMENT_CONFIG: '0' } })).status, 'disabled');
});

test('producer submits the complete original to the existing broker and persists no credentials', async t => {
    let packet;
    const server = createServer((req, res) => {
        assert.equal(req.url, '/submit');
        assert.equal(req.headers.authorization, 'Bearer fixture-private-token');
        let body = ''; req.on('data', chunk => { body += chunk; });
        req.on('end', () => { packet = JSON.parse(body); res.end(JSON.stringify({ status: 'queued', job_id: 'b'.repeat(32) })); });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => server.close());
    const f = configuration(t, server.address().port), original = '첫 줄\r\n끝의 필수 조건\n';
    const result = await observeComparison(event(original), { cwd: f.root, env: f.env });
    assert.equal(result.status, 'queued');
    assert.equal(JSON.parse(packet.stdin).items[0].text, original);
    assert.equal(JSON.parse(packet.stdin).source, 'grafly');
    assert.ok(packet.argv.includes('observe') && packet.argv.includes('fixture-thread'));
    const saved = readFileSync(join(f.root, 'comparison-status.json'), 'utf8');
    assert.ok(!saved.includes('fixture-private-token') && !saved.includes(original));
});

test('private material, oversized blocks and absent sessions are skipped without calls', async t => {
    const f = configuration(t, 1);
    for (const text of ['x'.repeat(65000), 'Authorization: Bearer private-credential-value', '{"api_key":"private-credential-value"}']) {
        const result = await observeComparison(event(text), { env: f.env });
        assert.equal(result.reason, 'input_size_or_private_material');
    }
    assert.equal((await observeComparison(event('body'), { env: { ...f.env, CODEX_THREAD_ID: '' } })).reason, 'active_session_unavailable');
});

test('broker outage does not reject the caller or lose original text', async t => {
    const f = configuration(t, 1), original = event('required original');
    const before = structuredClone(original);
    assert.equal((await observeComparison(original, { env: f.env })).status, 'unavailable');
    assert.deepEqual(original, before);
});

test('basic mode disables automatic submissions even when the consumer is configured', async t => {
    const f = configuration(t, 1);
    writeFileSync(join(f.config.state_root, 'model-access', 'settings.json'), JSON.stringify({ mode: 'basic' }));
    assert.equal((await observeComparison(event('body'), { env: f.env })).reason, 'model_mode');
});

test('block construction preserves every byte, including the required tail and stderr', () => {
    const stdout = Array.from({ length: 257 }, (_, i) => `line ${i}\r\n`).join('') + '필수 마지막 조건';
    const stderr = 'a warning\n';
    const rows = outputItems(stdout, stderr);
    assert.ok(rows.length <= 32);
    assert.equal(rows.filter(r => r.id.startsWith('stdout:')).map(r => r.text).join(''), stdout);
    assert.equal(rows.filter(r => r.id.startsWith('stderr:')).map(r => r.text).join(''), stderr);
    assert.ok(rows.filter(r => r.id.startsWith('stderr:')).every(r => r.protected));
    assert.ok(outputItems(stdout, stderr, true).every(r => r.protected));
});

test('API4 exact file contract accepts context judgment and rejects missing files or future APIs', () => {
    assert.equal(FILES_V4.length, FILES_V3.length + 2);
    const files = Object.fromEntries(FILES_V4.map(name => [name, { data: Buffer.from('# fixture').toString('base64'), sha256: sha256('# fixture') }]));
    const provided_channels = ['tool_output', 'symbol_disambiguation', 'patch_quality', 'context_judgment'];
    const bundle = { schema: 'mc.runtime.bundle.v1', version: '0.4.0', source: 'a'.repeat(40), runtime_api: 4,
        python_min: '3.11', channels: Object.fromEntries(provided_channels.map(id => [id, { version: '0.1.0', tag: `channel/${id}/v0.1.0` }])), provided_channels, files };
    const check = value => {
        const bytes = Buffer.from(JSON.stringify(value));
        return verifyBundle(bytes, { ...value, bytes: bytes.length, sha256: sha256(bytes) });
    };
    assert.equal(check(bundle).runtime_api, 4);
    assert.throws(() => check({ ...bundle, runtime_api: 5 }), /mc_bundle_contract/);
    delete files['morecoffee/judgment.py'];
    assert.throws(() => check(bundle), /mc_bundle_contract/);
});
