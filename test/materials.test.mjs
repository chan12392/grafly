import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildGraph } from '../dist/graph/build.js';
import { ask, askAsync, hitFiles } from '../dist/ask/ask.js';
import { readGraph, wiringPath } from '../dist/graph/write.js';
import { ensureFreshGraph } from '../dist/graph/refresh.js';
import { probeDrift } from '../dist/graph/fingerprint.js';
import { readMaterials, materialsPath } from '../dist/materials/index.js';
import { stampFiles, indexDeps, verify } from '../dist/ask/answer-cache.js';
import { OpenAIChatModel } from '../dist/ai/llm/openai.js';
import { AnthropicChatModel } from '../dist/ai/llm/anthropic.js';
import { federateAsk, writeWorkspace } from '../dist/graph/workspace.js';
import OpenAI from 'openai';

const cli = resolve('dist/cli.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYZkAAAAASUVORK5CYII=', 'base64');
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-materials-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const put = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
    put('src/orders.ts', 'export function shipOrder() { return "shipped"; }\n');
    put('docs/orders.md', '# Orders\n\nFulfillment decisions use `shipOrder` in [the source](../src/orders.ts).\n');
    return { root, out: join(root, '.grafly'), put };
}
function pdf(pages, fontSize = 12) {
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    const kids = [];
    for (const text of pages) {
        const page = objects.length + 1, stream = page + 1;
        kids.push(`${page} 0 R`);
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 3 0 R >> >> /Contents ${stream} 0 R >>`);
        const data = text ? `BT /F1 ${fontSize} Tf 20 200 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET` : '';
        objects.push(`<< /Length ${Buffer.byteLength(data)} >>\nstream\n${data}\nendstream`);
    }
    objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`;
    let result = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
    const xref = Buffer.byteLength(result);
    result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    result += offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
    return Buffer.from(result + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('normal build retrieves documents, PDF pages and explicit code references without a model', async t => {
    const f = fixture(t);
    f.put('docs/manual.pdf', pdf(['NebulaFulfillment shipOrder', 'Another page']));
    f.put('docs/diagram.png', png);
    const result = await buildGraph(f.root);
    assert.deepEqual(result.errors, []);
    assert.equal(result.materials.files, 3);
    assert.equal(result.materials.pending, 1);
    const docs = ask(f.root, 'Fulfillment', { source: true, in: 'docs' });
    const doc = docs.hits.find(h => h.material?.path === 'docs/orders.md');
    assert.match(doc.code, /shipOrder/);
    assert.ok(doc.references.some(r => r.pointer.startsWith('src/orders.ts:') && r.relation === 'mentions'));
    assert.ok(hitFiles([doc]).has('docs/orders.md'));
    const hit = (await askAsync(f.root, 'NebulaFulfillment', { source: true, in: 'docs' })).hits[0];
    assert.equal(hit.material.page, 1);
    assert.equal(hit.material.method, 'pdf-text');
    assert.match(hit.pointer, /manual.pdf#page=1/);
    assert.match(hit.code, /NebulaFulfillment/);
    const symbol = ask(f.root, 'shipOrder', { source: true }).hits.find(h => h.kind === 'symbol');
    assert.ok(symbol.related.some(p => p.startsWith('docs/orders.md:')));
    const graph = readGraph(wiringPath(f.out));
    assert.ok(!graph.nodes.some(n => n.path.startsWith('docs/')));
    const saved = readMaterials(f.out);
    assert.equal(saved.files.find(x => x.kind === 'image').status, 'pending');
    const again = await buildGraph(f.root);
    assert.equal(again.materials.cached, 3);
    assert.equal(again.materials.extracted, 0);
});

test('vision reads images and scanned PDF pages; a later offline refresh retains the extraction', async t => {
    const f = fixture(t), requests = [];
    f.put('docs/diagram.png', png);
    f.put('docs/scanned.pdf', pdf(['TextLayer', '']));
    const vision = { label: 'test:vision', async create(req) {
        requests.push(req); return { text: 'ReceiptOptical shipOrder', toolCalls: [] };
    } };
    await buildGraph(f.root);
    const result = await buildGraph(f.root, { vision });
    assert.deepEqual(result.errors, []);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(r => r.messages[1].images[0].mimeType === 'image/png'));
    const hits = ask(f.root, 'ReceiptOptical', { source: true, in: 'docs', limit: 20 }).hits;
    assert.ok(hits.some(h => h.kind === 'image' && h.material.method === 'vision'));
    assert.ok(hits.some(h => h.material.page === 2));
    assert.ok(hits.every(h => h.references.some(r => r.confidence === 'vision')));
    const again = await buildGraph(f.root);
    assert.equal(again.materials.pending, 0);
    assert.equal(again.materials.cached, 3);
    assert.ok(ask(f.root, 'ReceiptOptical').hits.length);
});

test('material-only edits, additions and deletions refresh ask and invalidate saved answers', async t => {
    const f = fixture(t);
    await buildGraph(f.root);
    const files = stampFiles(f.root, indexDeps(f.out, f.root));
    f.put('docs/orders.md', 'NewPolicyWord shipOrder\n');
    assert.deepEqual(probeDrift(f.root, f.out).changed, ['docs/orders.md']);
    assert.equal((await ensureFreshGraph(f.root)).refreshed, true);
    assert.equal(verify(f.root, { text: 'cached', stamp: files }), false);
    assert.match(ask(f.root, 'NewPolicyWord', { source: true }).hits[0].code, /NewPolicyWord/);
    f.put('docs/extra.txt', 'SecondPolicyWord');
    assert.equal((await ensureFreshGraph(f.root)).refreshed, true);
    rmSync(join(f.root, 'docs/orders.md'));
    await ensureFreshGraph(f.root);
    assert.ok(ask(f.root, 'NewPolicyWord').hits.every(h => h.material?.path !== 'docs/orders.md'));
    assert.equal(ask(f.root, 'SecondPolicyWord').hits[0].kind, 'document');
});

test('ambiguous identifiers abstain; source edits relink cached document evidence', async t => {
    const f = fixture(t);
    f.put('src/other.ts', 'export function duplicate() {}\n');
    f.put('src/again.ts', 'export function duplicate() {}\n');
    f.put('docs/ambiguous.md', 'duplicate');
    f.put('docs/scoped.md', 'duplicate src/other.ts');
    await buildGraph(f.root);
    let files = readMaterials(f.out).files;
    assert.equal(files.find(f => f.path.endsWith('ambiguous.md')).chunks[0].references.length, 0);
    assert.ok(files.find(f => f.path.endsWith('scoped.md')).chunks[0].references.some(r => r.evidence === 'duplicate'));
    f.put('src/orders.ts', 'export function renamedOrder() {}\n');
    await buildGraph(f.root);
    files = readMaterials(f.out).files;
    assert.ok(!files.find(f => f.path.endsWith('orders.md')).chunks[0].references.some(r => r.evidence === 'shipOrder'));
});

test('ignore rules, directory limits, binary size allowance and extraction failures are explicit', async t => {
    const f = fixture(t);
    spawnSync('git', ['init', '-q'], { cwd: f.root, windowsHide: true });
    f.put('.gitignore', 'private/\n');
    f.put('private/secret.md', 'NeverIndexSecret');
    f.put('docs/large.pdf', Buffer.concat([pdf(['LargePdfWord']), Buffer.alloc(1_100_000, 32)]));
    f.put('docs/broken.pdf', 'bad pdf');
    const result = await buildGraph(f.root, { onlyDirs: ['docs'] });
    assert.equal(result.structuralErrors, 0);
    assert.ok(result.materials.errors.some(e => e.startsWith('docs/broken.pdf:')));
    assert.ok(ask(f.root, 'LargePdfWord').hits.length);
    assert.equal(ask(f.root, 'NeverIndexSecret').hits.length, 0);
    assert.equal(probeDrift(f.root, f.out).added.length, 0);
    f.put('outside.md', 'OutsideBoundary');
    assert.equal((await ensureFreshGraph(f.root)).refreshed, false);
    assert.ok(!readMaterials(f.out).files.some(f => f.path === 'outside.md'));
});

test('CLI builds and searches material-only repositories and reports malformed PDF failures', t => {
    const f = fixture(t);
    rmSync(join(f.root, 'src'), { recursive: true });
    const run = args => spawnSync(process.execPath, [cli, ...args], {
        cwd: f.root, windowsHide: true, encoding: 'utf8', env: { ...process.env, GRAFLY_SESSION_ID: '' },
    });
    let r = run(['build']);
    assert.equal(r.status, 0, r.stderr);
    r = run(['ask', 'Fulfillment', '--in', 'docs', '--source', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).hits[0].kind, 'document');
    f.put('bad.pdf', 'broken');
    assert.equal(run(['build']).status, 1);
    assert.equal(run(['build', '--allow-partial']).status, 0);
});

test('existing OpenAI and Anthropic transports carry image data without changing text turns', async () => {
    const images = [{ mimeType: 'image/png', data: png.toString('base64') }];
    let openai, anthropic;
    const oa = new OpenAIChatModel({ apiKey: 'test', model: 'vision', client: { chat: { completions: { async create(req) {
        openai = req; return { choices: [{ message: { content: 'ok' } }], usage: {} };
    } } } } });
    await oa.create({ messages: [{ role: 'user', content: 'read', images }] });
    assert.match(openai.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
    await oa.create({ messages: [{ role: 'user', content: 'plain' }] });
    assert.equal(openai.messages[0].content, 'plain');
    const an = new AnthropicChatModel({ apiKey: 'test', model: 'vision', client: { messages: { async create(req) {
        anthropic = req; return { content: [{ type: 'text', text: 'ok' }], usage: {}, stop_reason: 'end_turn' };
    } } } });
    await an.create({ messages: [{ role: 'user', content: 'read', images }] });
    assert.deepEqual(anthropic.messages[0].content[1].source, { type: 'base64', media_type: 'image/png', data: images[0].data });
});

test('vision failures preserve valid pages and cached image evidence, and stop on terminal provider errors', async t => {
    const f = fixture(t);
    f.put('docs/scanned.pdf', pdf(['DurableTextLayer', '', '']));
    let calls = 0;
    const failing = { label: 'test:failure', async create() { calls++; throw new Error('401 invalid api key'); } };
    const result = await buildGraph(f.root, { vision: failing });
    assert.equal(calls, 1);
    assert.equal(result.materials.errors.length, 1);
    assert.match(ask(f.root, 'DurableTextLayer', { source: true }).hits[0].code, /DurableTextLayer/);
    f.put('docs/diagram.png', png);
    await buildGraph(f.root, { vision: { label: 'test:good', async create() { return { text: 'DurableCaption shipOrder' }; } } });
    await buildGraph(f.root, { vision: failing });
    await buildGraph(f.root);
    assert.ok(ask(f.root, 'DurableCaption').hits.some(h => h.kind === 'image'));
    f.put('docs/diagram.png', Buffer.concat([png, Buffer.from('changed')]));
    await buildGraph(f.root);
    assert.ok(!ask(f.root, 'DurableCaption').hits.some(h => h.material?.path === 'docs/diagram.png'));
});

test('workspace retrieval qualifies original paths, references and code backlinks', async t => {
    const f = fixture(t), child = 'project';
    mkdirSync(join(f.root, child));
    mkdirSync(join(f.root, child, 'src'));
    mkdirSync(join(f.root, child, 'docs'));
    writeFileSync(join(f.root, child, 'src/orders.ts'), 'export function shipOrder() {}\n');
    writeFileSync(join(f.root, child, 'docs/order policy.md'), 'shipOrder fulfillment\n');
    await buildGraph(join(f.root, child));
    writeWorkspace(f.root, { version: 1, children: [child] });
    const hits = federateAsk(f.root, undefined, 'shipOrder', { source: true, limit: 20 }).hits;
    const doc = hits.find(h => h.material);
    assert.equal(doc.material.path, 'project/docs/order policy.md');
    assert.ok(doc.pointer.startsWith('project/docs/order policy.md:'));
    assert.ok(doc.references.every(r => r.pointer.startsWith('project/')));
    assert.ok(hits.find(h => h.exactSymbol).related.every(p => p.startsWith('project/')));
});

test('long single-line documents and PDF pages retain distinct excerpt identities and matching source text', async t => {
    const f = fixture(t);
    f.put('docs/long.txt', 'padding '.repeat(1400) + 'DistinctDocumentTail');
    f.put('docs/long.pdf', pdf(['padding '.repeat(1400) + 'DistinctPdfTail'], 0.01));
    const result = await buildGraph(f.root);
    assert.deepEqual(result.errors, []);
    const files = readMaterials(f.out).files.filter(f => f.path.includes('long.'));
    for (const file of files) assert.equal(new Set(file.chunks.map(c => c.id)).size, file.chunks.length);
    assert.ok(files.find(f => f.kind === 'pdf').chunks.some(c => c.text.includes('DistinctPdfTail')),
        JSON.stringify(files.find(f => f.kind === 'pdf').chunks.map(c => ({ length: c.text.length, end: c.text.slice(-50) }))));
    for (const query of ['DistinctDocumentTail', 'DistinctPdfTail']) {
        const hit = ask(f.root, query, { source: true }).hits[0];
        assert.ok(hit.code.includes(query), JSON.stringify({ query, pointer: hit.pointer, material: hit.material, end: hit.code.slice(-100) }));
        assert.ok(hit.code.length <= 4000);
    }
});

test('plain vision falls back to Responses only for the observed data-URL proxy rejection', async () => {
    let responseRequest, responses = 0;
    const error = new OpenAI.APIError(500, { message: 'URL scheme must be http or https, got data:' }, 'proxy failure', new Headers());
    const model = new OpenAIChatModel({ model: 'existing-model', apiKey: 'test', client: {
        chat: { completions: { async create() { throw error; } } },
        responses: { async create(req) { responseRequest = req; responses++; return { output_text: 'shipOrder', status: 'completed',
            usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } } }; } },
    } });
    const messages = [{ role: 'user', content: 'read', images: [{ mimeType: 'image/png', data: 'test' }] }];
    const result = await model.create({ messages, maxTokens: 128 });
    assert.equal(result.text, 'shipOrder');
    assert.equal(result.usage.input, 10);
    assert.equal(responseRequest.model, 'existing-model');
    assert.equal(responseRequest.max_output_tokens, 128);
    assert.equal(responseRequest.input[0].content[1].type, 'input_image');
    await assert.rejects(model.create({ messages: [{ role: 'user', content: 'plain' }] }));
    await assert.rejects(model.create({ messages, tools: [{ name: 'work', parameters: {} }] }));
    assert.equal(responses, 1);
});
