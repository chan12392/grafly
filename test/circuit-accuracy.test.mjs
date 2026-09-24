import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { judgeSymbols } from '../dist/circuit/judge.js';
import { resolveSymbol } from '../dist/graph/traverse.js';
import { judgeAndRank, circuitVerdictLine } from '../dist/graph/traverse-cli.js';
import { federateCallers } from '../dist/graph/workspace.js';
import { circuitAccuracyCases } from './fixtures/circuit-accuracy-cases.mjs';

for (const c of circuitAccuracyCases()) {
    test(`circuit contract: ${c.id}`, () => {
        const matches = resolveSymbol(c.graph, c.query, c.scope ? { in: c.scope } : {});
        const result = judgeSymbols(c.graph, c.query, matches, { cwdTokens: new Set(c.cwd) });
        assert.equal(result.verdict, c.expected.verdict);
        assert.equal(result.verdict === 'confident' ? result.ranked[0].node.id : null,
            c.expected.selected);
    });
}

test('unsupported confidence explains the evidence gate, not a false gap inequality', () => {
    const c = circuitAccuracyCases()[0];
    const matches = resolveSymbol(c.graph, c.query);
    const { circuit } = judgeAndRank(c.graph, c.query, matches);
    assert.equal(circuit.verdict, 'abstain');
    assert.ok(circuit.reasonCodes.includes('equivalent_query_evidence'));
    assert.match(circuitVerdictLine(circuit, 2), /abstain/);
    assert.doesNotMatch(circuitVerdictLine(circuit, 2), /< 0\.5/);
});

test('equally supported peer below a different-context runner-up still prevents selection', () => {
    const c = circuitAccuracyCases()[0];
    const middle = { id: 'test/spec.js#work0', path: 'test/spec.js',
        name: 'work0', kind: 'function', span: 'L1-L1' };
    c.graph.nodes.push(middle);
    c.graph.edges.push(...c.graph.edges.map((e) => ({ ...e, target: middle.id })));
    const result = judgeSymbols(c.graph, c.query, resolveSymbol(c.graph, c.query));
    assert.equal(result.ranked[1].node.id, middle.id);
    assert.equal(result.verdict, 'abstain');
    assert.equal(result.reason, 'equivalent_query_evidence');
});

// Build actual JS source once: tests cover the CLI and the workspace surface,
// including an explicit scoped query that can select one.
test('abstention preserves all candidates through installed entry points', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grafly-circuit-surfaces-'));
    const child = join(root, 'child');
    mkdirSync(child);
    for (const name of ['a', 'b']) {
        writeFileSync(join(child, `${name}.js`), 'export function helper(){ return 1; }\n');
    }
    const cli = new URL('../dist/cli.js', import.meta.url);
    const { fileURLToPath } = await import('node:url');
    const run = (...args) => spawnSync(process.execPath, [fileURLToPath(cli), ...args],
        { cwd: child, encoding: 'utf8', windowsHide: true, timeout: 30000,
            env: { ...process.env, GRAFLY_CIRCUIT_LOG: '0' } });
    const built = run('build');
    assert.equal(built.status, 0, built.stderr);
    const result = run('callers', 'helper', '--json', '--top', '1');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).matches.length, 2);
    const text = run('callers', 'helper', '--top', '1');
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /a\.js/);
    assert.match(text.stdout, /b\.js/);
    assert.doesNotMatch(text.stdout, /top 1 of 2/);
    mkdirSync(join(root, 'grafly'));
    writeFileSync(join(root, 'grafly/workspace.json'), JSON.stringify({ version: 1, children: ['child'] }));
    const fed = federateCallers(root, undefined, 'helper', { top: 1 });
    assert.equal(fed.found, true);
    assert.match(fed.text, /a\.js/);
    assert.match(fed.text, /b\.js/);
    assert.doesNotMatch(fed.text, /top 1 of 2/);
    const scoped = run('callers', 'helper', '--in', 'a.js', '--top', '1');
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.match(scoped.stdout, /a\.js/);
    assert.doesNotMatch(scoped.stdout, /b\.js/);
});
