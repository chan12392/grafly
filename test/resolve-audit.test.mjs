import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFile } from '../dist/graph/extract.js';
import { resolveEdges } from '../dist/graph/resolve.js';

function resolveSources(files) {
    const extracted = Object.entries(files).map(([path, source]) =>
        extractFile(path, source, path.endsWith('.java') ? 'java' : 'typescript'));
    const dropped = [];
    const edges = resolveEdges(extracted.flatMap(r => r.nodes), extracted.flatMap(r => r.rawEdges), { dropped });
    return { edges, calls: edges.filter(e => e.relation === 'calls'), dropped };
}

test('same-file Java overloads with equal arity remain ambiguous', () => {
    const result = resolveSources({
        'C.java': 'class C { void save(int x) {} void save(String x) {} void run() { save("x"); } }',
    });
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.dropped, [{ source: 'C.java#C.run', name: 'save' }]);
});

test('Java arity narrowing still selects one overload', () => {
    const result = resolveSources({
        'C.java': 'class C { void save(int x) {} void save(int x, int y) {} void run() { save(1, 2); } }',
    });
    assert.deepEqual(result.calls, [{ source: 'C.java#C.run', target: 'C.java#C.save~2', relation: 'calls', confidence: 'extracted' }]);
    assert.deepEqual(result.dropped, []);
});

test('a unique same-file method wins over a same-named owner in another file', () => {
    const result = resolveSources({
        'one/C.java': 'class C { void save(int x) {} void run() { save(1); } }',
        'two/C.java': 'class C { void save(int x) {} }',
    });
    assert.deepEqual(result.calls, [{ source: 'one/C.java#C.run', target: 'one/C.java#C.save', relation: 'calls', confidence: 'extracted' }]);
    assert.deepEqual(result.dropped, []);
});

test('unresolved named exports never resolve to an unrelated global function', () => {
    for (const target of [
        'function helper() {} export { helper as work };',
        'export * from "./other.js";',
    ]) {
        const result = resolveSources({
            'target.js': target,
            'other.js': 'export function work() {}',
            'caller.js': 'import { work } from "./target.js"; export function run() { work(); }',
        });
        assert.deepEqual(result.calls, []);
        assert.deepEqual(result.dropped, [], 'an unsupported export is unresolved, not an ambiguous global name');
    }
});

test('ambiguous names inside an explicit module remain visible as dropped sites', () => {
    const result = resolveSources({
        'target.js': 'export function work() {} function container() { function work() {} }',
        'caller.js': 'import { work } from "./target.js"; export function run() { work(); }',
    });
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.dropped, [{ source: 'caller.js#run', name: 'work' }]);
});

test('import aliases and constructor references still resolve in the named module', () => {
    const result = resolveSources({
        'target.js': 'export function work() {} export class Widget {}',
        'other.js': 'export function work() {} export class Widget {}',
        'caller.js': 'import { work as task, Widget } from "./target.js"; export function run() { task(); new Widget(); }',
    });
    assert.deepEqual(result.calls.map(e => [e.source, e.target, e.confidence]), [
        ['caller.js#run', 'target.js#work', 'extracted'],
    ]);
    assert.ok(result.edges.some(e => e.source === 'caller.js#run' && e.target === 'target.js#Widget' && e.relation === 'references'));
    assert.deepEqual(result.dropped, []);
});
