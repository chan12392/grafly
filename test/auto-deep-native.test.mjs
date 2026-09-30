/** Opt-in native Codex regression: cached startup context precedes deep completion. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildGraph } from '../dist/graph/build.js';
import { autoDeepStatus } from '../dist/hosts/auto-deep.js';

const native = process.env.GRAFLY_TEST_CODEX;
test('native Codex uses saved context before background indexing finishes', { skip: !native, timeout: 35000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'grafly-deep-native-'));
    const home = join(dir, 'codex'), deepHome = join(dir, 'grafly'), cwd = join(dir, 'project');
    for (const p of [home, deepHome, join(cwd, '.git')]) mkdirSync(p, { recursive: true });
    writeFileSync(join(cwd, 'sample.js'), 'export function cachedFunction() { return 1; }\n');
    await buildGraph(cwd, { graphOnly: true });
    writeFileSync(join(cwd, '.grafly', 'INDEX.md'), '# CACHED_BEFORE_REFRESH\n');
    let modelAt = 0, probeAt = 0, probeDoneAt = 0, request;
    const server = createServer(async (req, res) => {
        if (req.url === '/v1/models') {
            probeAt = Date.now();
            await new Promise(r => setTimeout(r, 8000));
            probeDoneAt = Date.now();
            res.writeHead(503); res.end('intentionally unavailable fixture'); return;
        }
        if (req.method !== 'POST') { res.end('{"data":[]}'); return; }
        modelAt = Date.now();
        const chunks = []; for await (const b of req) chunks.push(b);
        let raw = Buffer.concat(chunks); if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw);
        request = JSON.parse(raw);
        const item = { id: 'msg', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'cached context received' }] };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of [
            { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } },
            { type: 'response.output_item.added', output_index: 0, item },
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: { id: 'r', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
        ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    writeFileSync(join(deepHome, 'auto-deep.json'), JSON.stringify({ enabled: true, roots: [cwd], baseUrl, model: 'gpt-5.6-luna' }));
    const shim = process.env.GRAFLY_TEST_SHIM || fileURLToPath(new URL('../scripts/grafly-devin-hook.cjs', import.meta.url));
    const config = join(home, 'config.toml');
    writeFileSync(config, `model="gpt-5.1-codex"\nmodel_provider="fixture"\napproval_policy="never"\nsandbox_mode="danger-full-access"\n[model_providers.fixture]\nname="Loopback test"\nbase_url="${baseUrl}"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`);
    writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: `node "${shim}" session-start`, timeout: 15 }] }] } }));
    const client = () => {
        const child = spawn(native, ['app-server', '--listen', 'stdio://'], { cwd, windowsHide: true, env: { ...process.env, CODEX_HOME: home, USERPROFILE: deepHome, HOME: deepHome, GRAFLY_AUTO_DEEP_HOME: deepHome, GRAFLY_NO_SELF_UPDATE: '1' } });
        const pending = new Map(), messages = []; let sequence = 0, errors = '';
        child.stderr.on('data', b => { errors += b; });
        createInterface({ input: child.stdout }).on('line', line => {
            const msg = JSON.parse(line); messages.push(msg);
            if (pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
        });
        const call = (method, params) => new Promise((resolve, reject) => {
            const id = ++sequence, timer = setTimeout(() => reject(new Error(`${method}: ${errors.slice(-500)}`)), 15000);
            pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
        });
        return { child, call, messages, errors: () => errors, init: async () => {
            await call('initialize', { clientInfo: { name: 'grafly-deep-test', version: '1' }, capabilities: { experimentalApi: true } });
            child.stdin.write('{"method":"initialized"}\n');
        } };
    };
    const inspection = client(); t.after(() => inspection.child.kill()); await inspection.init();
    const listed = await inspection.call('hooks/list', { cwds: [cwd] });
    for (const h of listed.data.flatMap(row => row.hooks)) appendFileSync(config, `\n[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash=${JSON.stringify(h.currentHash)}\n`);
    inspection.child.stdin.end(); await once(inspection.child, 'exit');
    const host = client(); t.after(() => host.child.kill()); await host.init();
    const started = await host.call('thread/start', { cwd, model: 'gpt-5.1-codex', modelProvider: 'fixture', approvalPolicy: 'never', sandbox: 'danger-full-access', baseInstructions: 'Loopback fixture.', developerInstructions: 'Use cached context.' });
    const turnAt = Date.now();
    await host.call('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Read the saved index context.' }] });
    const deadline = Date.now() + 20000;
    while ((!probeDoneAt || autoDeepStatus(deepHome).jobs.length || !host.messages.some(m => m.method === 'turn/completed')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.ok(modelAt, host.errors());
    assert.match(JSON.stringify(request.input), /CACHED_BEFORE_REFRESH/);
    assert.ok(probeAt && probeDoneAt, 'the background worker must run');
    assert.ok(modelAt < probeDoneAt, 'the first model request must precede indexing completion');
    assert.ok(modelAt - turnAt < 5000, `first model request delayed ${modelAt - turnAt}ms`);
    assert.equal(autoDeepStatus(deepHome).jobs.length, 0);
    assert.equal(autoDeepStatus(deepHome).projects[0].status, 'failed', 'fixture outage must be recorded after the response');
    t.diagnostic(`native first model request ${modelAt - turnAt}ms; background probe completed ${probeDoneAt - turnAt}ms`);
    host.child.stdin.end(); await once(host.child, 'exit');
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true });
});
