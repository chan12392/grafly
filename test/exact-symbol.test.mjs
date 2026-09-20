import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { ask } from '../dist/ask/ask.js';
import { federateAsk } from '../dist/graph/workspace.js';
import { writeGraph } from '../dist/graph/write.js';
import { writeAskIndex } from '../dist/ask/index-file.js';
import { queryIdentifiers } from '../dist/ask/exact-symbol.js';
import { relevantRetrieval } from '../dist/claude/format.js';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-exact-'));
    t.after(() => {
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        rmSync(root, { recursive: true, force: true });
    });
    return root;
}
function node(name, path = 'src/state.js', line = 1, extra = {}) {
    return { id: `${path}:${name}:${line}`, name, kind: 'function', path,
        span: `L${line}-L${line}`, signature: `function ${name}()`, ...extra };
}
function build(root, nodes, { sidecar = true, edges = [], scopes } = {}) {
    const graph = { version: 1, nodes, edges, meta: { ...(scopes ? { scopes } : {}) } };
    const out = join(root, 'grafly');
    if (sidecar) writeAskIndex(out, graph);
    writeGraph(graph, out);
    for (const n of nodes) {
        const p = join(root, n.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, 'export function fixture() {}\n'.repeat(100));
    }
}
function collisions() {
    return Array.from({ length: 32 }, (_, i) => node(`writeSessionCache${i}`,
        `src/cache${i}.js`, 1, { summary: 'persist session cache storage write session' }));
}
const query = 'Where does writeSession persist the session cache?';

for (const sidecar of [true, false]) {
    test(`exact definition survives truncation and file ranking (sidecar=${sidecar})`, (t) => {
        const root = fixture(t);
        build(root, [node('writeSession'), ...collisions()], { sidecar });
        for (const opts of [{}, { fileTopLock: false }, { fileFirst: false }, { graphRank: false }]) {
            const result = ask(root, query, { ...opts, limit: 1 });
            assert.equal(result.hits[0].title, 'writeSession · function');
            assert.equal(result.hits[0].exactSymbol, true);
        }
    });
}

for (const name of ['write_session', 'SessionStore', 'SESSION_CACHE', '$session', 'q', 'get']) {
    test(`explicit identifier ${name} resolves even with no lexical tokens`, (t) => {
        const root = fixture(t);
        build(root, [node(name), ...collisions()]);
        for (const text of [name, `Explain \`${name}\``, `Locate ${name}()`]) {
            const r = ask(root, text, { limit: 1 });
            assert.equal(r.mode, 'lexical');
            assert.equal(r.hits[0].title, `${name} · function`);
            assert.equal(r.hits[0].exactSymbol, true);
        }
    });
}

test('natural prose and paths do not opt into exact-symbol promotion', () => {
    for (const text of ['Where is the session cache?', 'Write the session cache',
        'How does authentication work?', 'src/writeSession.js', 'my-writeSession-file', '9writeSession'])
        assert.deepEqual([...queryIdentifiers(text)], [], text);
    assert.deepEqual([...queryIdentifiers('writeSession은 어디에 저장해?')], ['writeSession']);
});

test('sentence punctuation still locates the complete identifier', (t) => {
    const root = fixture(t);
    build(root, [node('writeSession'), ...collisions()]);
    for (const query of ['Explain writeSession.', 'Explain writeSession!', 'Explain writeSession?'])
        assert.equal(ask(root, query, { limit: 1 }).hits[0].exactSymbol, true);
});

test('long exact requests pass the prompt gate but retain per-session novelty', (t) => {
    const root = fixture(t);
    build(root, [node('writeSession'), ...collisions()]);
    const query = 'writeSession zebra apricot glacier telescope zirconium nebula ' +
        'orchestra marshmallow giraffe volcano penguin sapphire accordion oxygen';
    const r = ask(root, query, { limit: 3 });
    assert.ok(r.coverageStrong < 0.1 && r.coverage < 0.5, 'fixture must exercise the weak coverage gate');
    const session = {};
    assert.match(relevantRetrieval(r, session), /writeSession/);
    assert.equal(relevantRetrieval(r, session), null);
});

test('prefix collisions, file names, body mentions and different case are not exact', (t) => {
    const root = fixture(t);
    build(root, [node('writeSessionExtra'), node('writesession'),
        node('writeSession', 'writeSession.js', 1, { kind: 'file' }),
        node('writeCache', 'src/cache.js', 1, { summary: 'calls writeSession' })]);
    assert.equal(ask(root, query).hits.some((hit) => hit.exactSymbol), false);
});

test('qualified names preserve the named owner, unqualified names find qualified definitions', (t) => {
    const root = fixture(t);
    build(root, [node('Cache.get'), node('Other.get', 'src/other.js'), node('get', 'src/get.js')]);
    const exact = ask(root, 'Explain Cache.get').hits.filter((h) => h.exactSymbol);
    assert.deepEqual(exact.map((h) => h.title), ['Cache.get · function']);
    assert.equal(ask(root, '`get`').hits.filter((h) => h.exactSymbol).length, 3);
});

test('exact secondary spans and multiple identifiers appear once with source', (t) => {
    const root = fixture(t);
    build(root, [node('writeSession', 'src/state.js', 2), node('readSession', 'src/state.js', 3),
        node('writeSessionCache', 'src/state.js', 1, { summary: 'persist session cache' }), ...collisions()]);
    const r = ask(root, 'Compare writeSession and readSession', { limit: 3, source: true });
    assert.deepEqual(new Set(r.hits.slice(0, 2).map((h) => h.title)),
        new Set(['writeSession · function', 'readSession · function']));
    assert.ok(r.hits[0].code.includes('fixture'));
    assert.equal(new Set(r.hits.map((h) => h.pointer)).size, r.hits.length);
});

test('in-prefix filtering applies before exact matching in a multi-scope graph', (t) => {
    const root = fixture(t);
    build(root, [node('writeSession', 'backend/state.js'), node('writeSession', 'frontend/state.js'),
        ...collisions()], { scopes: [{ prefix: 'backend', label: 'backend', markers: [] },
            { prefix: 'frontend', label: 'frontend', markers: [] }, { prefix: '', label: '', markers: [] }] });
    const r = ask(root, query, { in: 'backend', limit: 3 });
    assert.equal(r.hits[0].pointer, 'backend/state.js:L1-L1');
    assert.ok(r.hits.every((h) => h.pointer.startsWith('backend/')));
});

test('structural callers keep the neighbour instead of promoting the subject', (t) => {
    const root = fixture(t);
    const target = node('writeSession');
    const caller = node('saveChanges', 'src/save.js');
    build(root, [target, caller], { edges: [{ source: caller.id, target: target.id, relation: 'calls' }] });
    const r = ask(root, 'who calls writeSession');
    assert.equal(r.mode, 'structural');
    assert.equal(r.hits[0].title, 'saveChanges');
    assert.equal(r.hits.some((h) => h.exactSymbol), false);
});

test('production definitions lead same-name tests; an explicit test query keeps tests eligible', (t) => {
    const root = fixture(t);
    build(root, [node('writeSession', 'test/state.test.js', 1, { summary: 'persist session cache' }),
        node('writeSession')]);
    assert.equal(ask(root, query).hits[0].pointer, 'src/state.js:L1-L1');
    assert.ok(ask(root, 'Tests for writeSession').hits.some((h) => h.pointer.startsWith('test/')));
});

for (const fileTopLock of [true, false]) {
    test(`workspace keeps exact evidence across ten repos (fileTopLock=${fileTopLock})`, (t) => {
        const root = fixture(t);
        const children = Array.from({ length: 9 }, (_, i) => `a${i}`).concat('z-target');
        for (const child of children)
            build(join(root, child), child === 'z-target' ? [node('writeSession'), ...collisions()] : collisions());
        mkdirSync(join(root, 'grafly'), { recursive: true });
        writeFileSync(join(root, 'grafly/workspace.json'), JSON.stringify({ version: 1, children }));
        for (const text of [query, 'writeSession zebra apricot glacier telescope zirconium nebula']) {
            const r = federateAsk(root, undefined, text, { limit: 3, fileTopLock, source: true });
            assert.equal(r.hits[0].pointer, 'z-target/src/state.js:L1-L1');
            assert.equal(r.hits[0].exactSymbol, true);
            assert.ok(r.hits[0].code.includes('fixture'));
            assert.ok(r.scopes.federated.includes('z-target'));
            assert.equal(r.scopes.alsoMatched.some((s) => s.scope === 'z-target'), false);
            assert.equal(new Set(r.hits.map((h) => h.pointer)).size, r.hits.length);
        }
        const scoped = federateAsk(root, undefined, query, { in: 'a0', fileTopLock });
        assert.equal(scoped.hits.some((h) => h.exactSymbol), false);
    });
}
