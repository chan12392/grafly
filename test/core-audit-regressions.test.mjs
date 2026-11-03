import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Grafly } from '../dist/engine.js';
import { ask } from '../dist/ask/ask.js';
import { parseFrontmatter } from '../dist/context/frontmatter.js';
import { readNodes, writeNode } from '../dist/context/node-file.js';
import { listContextFiles } from '../dist/context/build.js';
import { buildGraph } from '../dist/graph/build.js';
import { checkGraph } from '../dist/graph/check.js';
import { writeCards, writeCovers } from '../dist/graph/cards.js';
import { readGraph } from '../dist/graph/write.js';
import { executeSearch } from '../dist/search/request.js';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-core-audit-'));
    t.after(() => {
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        rmSync(root, { recursive: true, force: true });
    });
    return root;
}
const emptyGraph = { nodes: [], edges: [] };
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('build and metadata readers treat executable frontmatter as data', t => {
    const root = fixture(t), index = join(root, '.grafly');
    mkdirSync(index);
    writeFileSync(join(root, 'a.js'), 'export const a = 1;');
    const marker = join(root, 'executed.txt'), card = join(index, 'audit.md');
    const code = `(() => { require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'executed'); return {slug:'audit',sources:[],links:[]}; })()`;
    const hostile = `\uFEFF---javascript\r\n${code}\r\n---\r\nAudit.\n`;
    writeFileSync(card, hostile);
    for (const read of [
        () => readNodes(index),
        () => writeNode(index, { slug: 'audit' }),
        () => writeCards(emptyGraph, index),
        () => writeCovers(emptyGraph, index),
        () => ask(root, 'audit'),
    ]) assert.throws(read, /Unsupported concept frontmatter language/);
    const built = spawnSync(process.execPath, [cli, 'build', root], {
        windowsHide: true, encoding: 'utf8', timeout: 30000, env: { ...process.env, GRAFLY_NO_DAEMON: '1' },
    });
    assert.equal(built.status, 1, built.stderr);
    assert.match(built.stderr, /Unsupported concept frontmatter language/);
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(card, 'utf8'), hostile);
});

test('safe frontmatter keeps YAML/JSON compatibility and never reparses a card body', t => {
    const root = fixture(t), marker = join(root, 'executed.txt');
    for (const [language, data] of [['', 'slug: audit'], ['yaml', 'slug: audit'], ['YAML', 'slug: audit'], ['yml', 'slug: audit'], ['json', '{"slug":"audit"}']])
        assert.equal(parseFrontmatter(`\uFEFF---${language}\r\n${data}\r\n---\r\nBody`).data.slug, 'audit');
    const code = `(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); return {}; })()`;
    for (const language of ['javascript', 'js', 'JavaScript', ' javascript ', 'unknown', 'constructor', '__proto__'])
        assert.throws(() => parseFrontmatter(`---${language}\n${code}\n---\n`), /Unsupported concept frontmatter language/);
    parseFrontmatter(`\uFEFF\uFEFF---javascript\n${code}\n---\n`);
    const body = `---javascript\n${code}\n---\nHuman notes remain.\n`;
    const card = join(root, 'audit.md');
    writeFileSync(card, `---\nslug: audit\nsources: []\n---\n${body}`);
    assert.equal(writeCovers(emptyGraph, root), 1);
    assert.equal(parseFrontmatter(readFileSync(card, 'utf8')).content, body);
    assert.equal(existsSync(marker), false);
});

test('public full deep regeneration archives retired notes and leaves file cards intact', async t => {
    const root = fixture(t), source = join(root, 'a.js');
    writeFileSync(source, 'export const a = 1;');
    await buildGraph(root);
    const fileCard = join(root, '.grafly', 'a.md'), originalFileCard = readFileSync(fileCard, 'utf8');
    let name = 'Old Concept', fail = false;
    const engine = new Grafly();
    engine.summarizer = () => ({ summarize: async code => code });
    engine.synthesizer = () => ({ synthesize: async files => {
        if (fail) throw new Error('fixture offline');
        return [{ name, type: 'concept', summary: name, sources: files.map(file => file.path), links: [] }];
    } });
    await engine.init(root);
    const old = join(root, '.grafly', 'old-concept.md');
    writeFileSync(old, readFileSync(old, 'utf8') + '\nHuman production rollback notes.\n');
    const notes = readFileSync(old, 'utf8');
    writeFileSync(source, 'export const a = 2;');
    name = 'New Concept'; fail = true;
    assert.ok((await engine.init(root)).errors.length);
    assert.equal(readFileSync(old, 'utf8'), notes);
    fail = false;
    assert.equal((await engine.init(root)).errors.length, 0);
    assert.equal(existsSync(old), false);
    const history = join(root, '.grafly', '.cache', 'concept-history');
    assert.equal(readFileSync(join(history, readdirSync(history)[0], 'old-concept.md'), 'utf8'), notes);
    assert.equal(readFileSync(fileCard, 'utf8'), originalFileCard);
    assert.equal(existsSync(join(root, '.grafly', 'new-concept.md')), true);
});

test('a newly added concept invalidates a cached zero-hit answer with ordinary refresh', async t => {
    const root = fixture(t);
    writeFileSync(join(root, 'a.js'), 'export const a = 1;');
    await buildGraph(root, { graphOnly: true });
    const query = { command: 'ask', query: 'xylophonium', dir: root, opts: { xerj: false, json: true } };
    assert.equal(JSON.parse((await executeSearch(query)).stdout).hits.length, 0);
    assert.match((await executeSearch(query)).stderr, /answer cache hit/);
    writeFileSync(join(root, '.grafly', 'xylophonium.md'), '---\nname: Xylophonium\nslug: xylophonium\nsources: []\nlinks: []\n---\nXylophonium explains the service.\n');
    const updated = await executeSearch(query);
    assert.equal(updated.exitCode, 0, updated.stderr);
    assert.doesNotMatch(updated.stderr, /answer cache hit/);
    assert.equal(JSON.parse(updated.stdout).hits.length, 1);
    assert.match((await executeSearch(query)).stderr, /answer cache hit/);
});

test('custom output paths exclude only their directory, including trailing separators', async t => {
    const root = fixture(t), index = join(root, 'index');
    mkdirSync(index);
    writeFileSync(join(root, 'index-helper.js'), 'export function requiredSource(){ return 7; }');
    writeFileSync(join(index, 'generated.js'), 'export const generated = 1;');
    const built = await buildGraph(root, { contextDir: index, graphOnly: true });
    assert.deepEqual([...new Set(readGraph(built.graphPath).nodes.map(node => node.path))], ['index-helper.js']);
    assert.equal((await checkGraph(root, { contextDir: index })).ok, true);
    for (const outDir of [index, index + sep])
        assert.deepEqual(listContextFiles(root, outDir, ['.js']), [join(root, 'index-helper.js')]);
    assert.deepEqual(listContextFiles(root, root, ['.js']), []);
});
