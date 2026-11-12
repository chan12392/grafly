import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

test('short-lived command callers finish only after both local submission acknowledgments', async t => {
    const packets = [];
    const server = createServer((req, res) => {
        let body = ''; req.on('data', chunk => { body += chunk; });
        req.on('end', () => { packets.push(JSON.parse(JSON.parse(body).stdin));
            res.end(JSON.stringify({ status: 'queued', job_id: 'b'.repeat(32) })); });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => server.close());
    const f = configuration(t, server.address().port);
    const probe = join(f.root, 'probe.cjs'), caller = join(f.root, 'caller.mjs');
    writeFileSync(probe, "process.stdout.write('preserved output\\n');\n");
    const run = async (command, args) => {
        writeFileSync(caller, `import { runCommand } from ${JSON.stringify(new URL('../dist/tool-output/runner.js', import.meta.url).href)};
const result = await runCommand(${JSON.stringify(command)}, ${JSON.stringify(args)});
process.exit(result.exit_code);\n`);
        return promisify(execFile)(process.execPath, [caller], { cwd: f.root, windowsHide: true,
        env: { ...process.env, ...f.env, GRAFLY_TOOL_OUTPUT: '1', GRAFLY_TOOL_OUTPUT_DIR: join(f.root, 'output'),
            GRAFLY_MC_RUNTIME_HOME: join(f.root, 'no-runtime'), MC_LEARNING_HOME: join(f.root, 'learning') } });
    };
    const result = await run(process.execPath, [probe]);
    assert.equal(result.stdout, 'preserved output\n');
    assert.deepEqual(packets.map(p => p.task), ['tool_call_suitability', 'input_block_retention']);
    assert.deepEqual(packets[0].items[0].tool, { name: process.execPath, arguments: { argv: [probe] },
        scope: f.root, effects: ['execute'],
        purpose: 'The caller requested this command; no independent scope judgment is available.' });
    assert.equal(packets[0].items[0].constraint_status, 'unknown');
    assert.equal(packets[0].items[0].protected, false);
    assert.equal(packets[1].items[0].text, result.stdout);
    assert.equal(JSON.parse(readFileSync(join(f.root, 'comparison-status.json'), 'utf8')).status, 'queued');
    const largeArgv = [probe, ...Array(65).fill('argument')];
    await run(process.execPath, largeArgv);
    assert.equal(packets[2].items[0].tool, undefined);
    assert.deepEqual(JSON.parse(packets[2].items[0].text).args, largeArgv);
    writeFileSync(join(f.root, 'left'), 'before\n'); writeFileSync(join(f.root, 'right'), 'after\n');
    await assert.rejects(run('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--exit-code', 'left', 'right']),
        error => error.code === 1 && error.stderr === '');
    assert.equal(packets.at(-1).task, 'input_block_retention');
    assert.ok(packets.at(-1).items.every(item => item.protected && item.role === undefined));
});

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
    const input = event(original);
    input.items[0].role = 'explanation'; input.items[0].requires = ['guard'];
    input.items.push({ id: 'guard', text: 'Known constraint.', protected: false, constraint_status: 'unknown', role: 'constraint' });
    const result = await observeComparison(input, { cwd: f.root, env: { ...f.env, OPENAI_API_KEY: 'fixture-private-api-key' } });
    assert.equal(result.status, 'queued');
    assert.equal(packet.environment, undefined);
    assert.ok(!JSON.stringify(packet).includes('fixture-private-api-key'));
    assert.equal(JSON.parse(packet.stdin).items[0].text, original);
    assert.equal(JSON.parse(packet.stdin).source, 'grafly');
    // The harness prepares once after adding the goal and constraints; this producer forwards actual facts unchanged.
    assert.deepEqual(JSON.parse(packet.stdin).items, input.items);
    assert.ok(packet.argv.includes('observe') && packet.argv.includes('fixture-thread'));
    const saved = readFileSync(join(f.root, 'comparison-status.json'), 'utf8');
    assert.ok(!saved.includes('fixture-private-token') && !saved.includes(original));
});

test('private material, oversized blocks and absent sessions are skipped without calls', async t => {
    const f = configuration(t, 1);
    for (const text of ['x'.repeat(65000), 'Authorization: Bearer private-credential-value', '{"api_key":"private-credential-value"}',
        'oauth_token: fixture-token-value', 'machine localhost login user password fixture-secret',
        'https://user:fixture-token-value@example.test', 'client-key-data: fixture-base64-key']) {
        const result = await observeComparison(event(text), { env: f.env });
        assert.equal(result.reason, 'input_size_or_private_material');
    }
    const metadata = event('No secret in this text.');
    metadata.items[0].tool = { name: 'request', arguments: { authorization: 'Bearer private-credential-value' },
        scope: 'local', effects: ['network'], purpose: 'request' };
    assert.equal((await observeComparison(metadata, { env: f.env })).reason, 'input_size_or_private_material');
    assert.equal((await observeComparison(event('body'), { env: { ...f.env, CODEX_THREAD_ID: '' } })).reason, 'active_session_unavailable');
});

test('only an actual failed command supplies failure roles; stderr alone remains a guard', () => {
    const failed = outputItems('partial result\n', 'failed\n', true);
    assert.ok(failed.every(item => item.role === 'failure' && item.protected));
    const warning = outputItems('result\n', 'warning\n');
    assert.ok(warning.every(item => item.role === undefined));
    assert.equal(warning[1].protected, true);
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
