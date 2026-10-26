import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { scheduleAutoDeep, runAutoDeepWorker, autoDeepStatus, buildDeepProject } from '../dist/hosts/auto-deep.js';
import { acquireLockIn, releaseLockIn } from '../dist/util/state.js';

function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'grafly-auto-deep-'));
    t.after(() => {
        assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
        rmSync(dir, { recursive: true, force: true });
    });
    const home = join(dir, 'home');
    const root = join(dir, 'project');
    mkdirSync(home);
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'sample.js'), 'export function classify(value) {\n if (value > 10) return "large";\n return "small";\n}\n');
    const configure = (extra = {}) => writeFileSync(join(home, 'auto-deep.json'), JSON.stringify({
        enabled: true, roots: [root], baseUrl: 'http://127.0.0.1:1/v1', model: 'gpt-5.6-luna', concurrency: 2, ...extra,
    }));
    return { dir, home, root, configure };
}

test('shared adapter startup dedup tolerates Windows timestamp skew', t => {
    const f = fixture(t);
    const { claimStartup } = createRequire(import.meta.url)('../scripts/grafly-devin-hook.cjs');
    const now = Date.now();
    assert.equal(claimStartup(f.root, { session_id: 'clock' }, 'orientation', now), true);
    const dir = join(f.root, '.grafly/.cache/hook-startup');
    const stamp = join(dir, readdirSync(dir)[0]);
    utimesSync(stamp, new Date(now + 20), new Date(now + 20));
    assert.equal(claimStartup(f.root, { session_id: 'clock' }, 'orientation', now), false);
    assert.equal(claimStartup(f.root, { session_id: 'clock' }, 'orientation', now + 6000), true);
});

test('automatic meaning is explicit, bounded to allowed git projects, and local-only', t => {
    const f = fixture(t);
    const opts = { home: f.home, launch: false };
    assert.equal(scheduleAutoDeep(f.root, opts), false);
    f.configure({ enabled: false });
    assert.equal(scheduleAutoDeep(f.root, opts), false);
    f.configure({ baseUrl: 'https://api.example.com/v1' });
    assert.equal(scheduleAutoDeep(f.root, opts), false);
    f.configure({ roots: [f.home] });
    assert.equal(scheduleAutoDeep(f.root, opts), false);
    f.configure();
    assert.equal(scheduleAutoDeep(f.root, opts), true);
    assert.equal(scheduleAutoDeep(f.root, opts), true);
    assert.equal(autoDeepStatus(f.home).jobs.length, 1);
});

test('one worker consumes duplicates once; successful projects cool down', async t => {
    const f = fixture(t); f.configure();
    scheduleAutoDeep(f.root, { home: f.home, launch: false });
    let calls = 0;
    const build = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return { status: 'ready' }; };
    await Promise.all([runAutoDeepWorker({ home: f.home, build }), runAutoDeepWorker({ home: f.home, build })]);
    assert.equal(calls, 1);
    assert.equal(autoDeepStatus(f.home).projects[0].status, 'ready');
    scheduleAutoDeep(f.root, { home: f.home, launch: false });
    assert.equal(autoDeepStatus(f.home).jobs.length, 0);
    scheduleAutoDeep(f.root, { home: f.home, launch: false, now: Date.now() + 3600001 });
    assert.equal(autoDeepStatus(f.home).jobs.length, 1);
});

test('every new session bypasses cooldown and a session arriving during a build is retained', async t => {
    const f = fixture(t); f.configure();
    const opts = { home: f.home, launch: false };
    scheduleAutoDeep(f.root, { ...opts, sessionId: 'first' });
    let calls = 0;
    await runAutoDeepWorker({ home: f.home, build: async () => {
        calls++;
        if (calls === 1) {
            scheduleAutoDeep(f.root, { ...opts, sessionId: 'first' });
            scheduleAutoDeep(f.root, { ...opts, sessionId: 'second' });
        }
        return { status: 'ready' };
    } });
    assert.equal(calls, 2);
    scheduleAutoDeep(f.root, { ...opts, sessionId: 'second' });
    assert.equal(autoDeepStatus(f.home).jobs.length, 0);
    scheduleAutoDeep(f.root, { ...opts, sessionId: 'third' });
    assert.equal(autoDeepStatus(f.home).jobs.length, 1);
});

test('unavailable model records failure while preserving usable structure, then retries', async t => {
    const f = fixture(t); f.configure();
    scheduleAutoDeep(f.root, { home: f.home, launch: false });
    await runAutoDeepWorker({ home: f.home });
    const state = autoDeepStatus(f.home).projects[0];
    assert.equal(state.status, 'failed');
    assert.ok(state.error);
    assert.ok(existsSync(join(f.root, '.grafly/.graph/wiring.json')));
    assert.equal(existsSync(join(f.root, '.grafly/.cache/.sync.lock')), false);
    scheduleAutoDeep(f.root, { home: f.home, launch: false, now: state.nextCheckAt + 1 });
    let count = 0;
    await runAutoDeepWorker({ home: f.home, build: async () => { count++; return { status: 'ready' }; } });
    assert.equal(count, 1);
});

test('active structural refresh prevents an overlapping deep write', async t => {
    const f = fixture(t);
    const cache = join(f.root, '.grafly/.cache');
    assert.equal(acquireLockIn(cache), true);
    try {
        const result = await buildDeepProject(f.root, { baseUrl: 'http://127.0.0.1:1/v1' });
        assert.equal(result.status, 'busy');
        assert.ok(existsSync(join(cache, '.sync.lock')));
    } finally { releaseLockIn(cache); }
});

async function modelServer(t, { emptyConcepts = false, omitSymbols = false } = {}) {
    const requests = [];
    const server = createServer(async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-luna' }] }));
        let raw = ''; for await (const chunk of req) raw += chunk;
        const request = JSON.parse(raw); requests.push(request);
        const tool = request.tools?.[0]?.function?.name;
        const messageText = m => typeof m.content === 'string' ? m.content : m.content.map(p => p.text).join('\n');
        const user = request.messages.filter(m => m.role === 'user').map(messageText).join('\n');
        let args;
        if (tool === 'record_graph') args = { nodes: [{ name: 'Classification', type: 'system', summary: 'Threshold classification.', sources: [...user.matchAll(/^## (.+)$/gm)].map(m => m[1]), links: [] }] };
        if (tool === 'record_symbols') args = { symbols: [...user.matchAll(/^- id=(.*?) \|/gm)].map(m => ({ id: m[1], summary: 'Classifies values using a threshold.', crux_start: 0, crux_end: 0 })) };
        if (tool === 'record_graph' && emptyConcepts) args = { nodes: [] };
        if (tool === 'record_symbols' && omitSymbols) args.symbols = args.symbols.filter(s => !s.id.includes('classify'));
        const message = args ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }
            : { role: 'assistant', content: 'classify applies a threshold and returns a size label.' };
        res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'gpt-5.6-luna', choices: [{ index: 0, message, finish_reason: args ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
    return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

test('real shared hook schedules deep; model responses produce ready symbols and cache reuse', async t => {
    const f = fixture(t); const model = await modelServer(t);
    f.configure({ baseUrl: model.baseUrl });
    const shim = fileURLToPath(new URL('../scripts/grafly-devin-hook.cjs', import.meta.url));
    const env = { ...process.env, GRAFLY_AUTO_DEEP_HOME: f.home, USERPROFILE: f.home, HOME: f.home, GRAFLY_NO_SELF_UPDATE: '1' };
    delete env.GRAFLY_NO_AUTO_INDEX; delete env.GRAFT_NO_AUTO_INDEX; delete env.GRAFLY_NO_AUTO_DEEP;
    const output = await new Promise((done, reject) => {
        const child = spawn(process.execPath, [shim, 'session-start'], { cwd: f.root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
        child.on('error', reject); child.on('exit', code => code === 0 ? done(out) : reject(new Error(err)));
        child.stdin.end(JSON.stringify({ cwd: f.root, session_id: 'auto-deep-acceptance' }));
    });
    assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /queued structural \+ deep/);
    const deadline = Date.now() + 30000;
    while (autoDeepStatus(f.home).jobs.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.equal(autoDeepStatus(f.home).jobs.length, 0, JSON.stringify(autoDeepStatus(f.home)));
    const state = autoDeepStatus(f.home).projects[0];
    assert.equal(state.status, 'ready', JSON.stringify(state));
    const graph = JSON.parse(readFileSync(join(f.root, '.grafly/.graph/wiring.json'), 'utf8'));
    assert.ok(graph.nodes.length > 0);
    assert.ok(graph.nodes.every(n => n.summary_state === 'ready' && n.summary));
    assert.ok(model.requests.some(r => r.tools?.[0]?.function?.name === 'record_symbols'));
    const calls = model.requests.length;
    const result = await buildDeepProject(f.root, { baseUrl: model.baseUrl, model: 'gpt-5.6-luna', concurrency: 2 });
    assert.equal(result.status, 'ready');
    assert.equal(model.requests.length, calls, 'unchanged source must not call the model again');
    const index = join(f.root, '.grafly'), notes = '# Archived concept\nOnly saved human notes.\n';
    const backups = ['.index-history/snapshot', '.migration-backups/snapshot/index'];
    for (const backup of backups) {
        mkdirSync(join(index, backup, 'nested/empty'), { recursive: true });
        writeFileSync(join(index, backup, 'nested/concept.md'), notes);
    }
    mkdirSync(join(index, 'src'), { recursive: true });
    writeFileSync(join(index, 'src/retired.md'), '# Retired generated card\n');
    writeFileSync(join(f.root, 'sample.js'), 'export function classify(value) {\n if (value > 20) return "large";\n return "small";\n}\n');
    assert.equal((await buildDeepProject(f.root, { baseUrl: model.baseUrl, model: 'gpt-5.6-luna', concurrency: 2 })).status, 'ready');
    assert.ok(model.requests.length > calls, 'changed source must recompute meaning');
    for (const backup of backups) {
        assert.equal(readFileSync(join(index, backup, 'nested/concept.md'), 'utf8'), notes);
        assert.ok(existsSync(join(index, backup, 'nested/empty')));
    }
    assert.equal(existsSync(join(index, 'src/retired.md')), false);
});

test('empty concepts and missing symbol results never claim ready', async t => {
    for (const failure of [{ emptyConcepts: true }, { omitSymbols: true }]) {
        const f = fixture(t); const model = await modelServer(t, failure);
        const result = await buildDeepProject(f.root, { baseUrl: model.baseUrl, model: 'gpt-5.6-luna', concurrency: 2 });
        assert.equal(result.status, 'incomplete', JSON.stringify(result));
    }
});

test('automatic deep preserves an existing only-dir boundary in both passes', async t => {
    const f = fixture(t); const model = await modelServer(t);
    mkdirSync(join(f.root, 'selected'));
    writeFileSync(join(f.root, 'selected/core.js'), readFileSync(join(f.root, 'sample.js')));
    writeFileSync(join(f.root, 'sample.js'), 'export const excludedSentinel = "do not summarize";');
    const { buildGraph } = await import('../dist/graph/build.js');
    await buildGraph(f.root, { onlyDirs: ['selected'], graphOnly: true });
    const result = await buildDeepProject(f.root, { baseUrl: model.baseUrl, model: 'gpt-5.6-luna', concurrency: 2 });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    const graph = JSON.parse(readFileSync(join(f.root, '.grafly/.graph/wiring.json'), 'utf8'));
    assert.ok(graph.nodes.every(n => n.path.startsWith('selected/')));
    assert.ok(!JSON.stringify(model.requests).includes('excludedSentinel'));
    const { readFingerprint } = await import('../dist/graph/fingerprint.js');
    assert.deepEqual(readFingerprint(join(f.root, '.grafly')).onlyDirs, ['selected']);
});
