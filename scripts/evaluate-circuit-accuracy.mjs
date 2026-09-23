import { contextDirFor } from '../dist/context/node-file.js';
// Paired local replay: fixed contract cases + existing real indexes.
// Usage: node scripts/evaluate-circuit-accuracy.mjs BASELINE OUTPUT ROOT...
// No network, model calls, graph refresh, or scanned-source execution.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { circuitAccuracyCases } from '../test/fixtures/circuit-accuracy-cases.mjs';

const [baselineArg, outputArg, ...roots] = process.argv.slice(2);
assert.ok(baselineArg && outputArg && roots.length, 'BASELINE OUTPUT ROOT... required');
const candidate = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = resolve(baselineArg), output = resolve(outputArg);
// Compare the checked-in weights, not a developer's custom model/threshold.
delete process.env.GRAFLY_WEIGHTS;
delete process.env.GRAFLY_ABSTAIN;
const load = async (root) => ({
    ...(await import(pathToFileURL(join(root, 'dist/circuit/judge.js')))),
    ...(await import(pathToFileURL(join(root, 'dist/graph/traverse.js')))),
});
const old = await load(baseline), next = await load(candidate);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const files = ['dist/circuit/judge.js', 'dist/circuit/weights.json',
    'dist/graph/traverse-cli.js', 'dist/graph/workspace.js', 'dist/mcp/tools.js'];
const inputs = {};
for (const root of [baseline, candidate]) for (const file of files) {
    const path = join(root, file); inputs[path] = digest(readFileSync(path));
}
const contract = circuitAccuracyCases();
const real = [];
for (const rootArg of roots) {
    const root = resolve(rootArg), path = join(contextDirFor(root), '.graph/wiring.json');
    const raw = readFileSync(path), graph = JSON.parse(raw);
    inputs[path] = digest(raw);
    const names = [...new Set(graph.nodes.filter((n) => n.kind !== 'file').map((n) => n.name))]
        .sort((a, b) => digest(a).localeCompare(digest(b)));
    let unique = 0, ambiguous = 0;
    for (const query of names) {
        const matches = old.resolveSymbol(graph, query);
        const isUnique = matches.length === 1;
        if (!matches.length || (isUnique ? unique : ambiguous) >= 50) continue;
        if (isUnique) unique++; else ambiguous++;
        real.push({ id: `${root}:${query}`, graph, query, cwd: [] });
        if (unique === 50 && ambiguous === 50) break;
    }
}
function run(engine, c) {
    const matches = engine.resolveSymbol(c.graph, c.query, c.scope ? { in: c.scope } : {});
    const r = engine.judgeSymbols(c.graph, c.query, matches, { cwdTokens: new Set(c.cwd) });
    return { verdict: r.verdict, selected: r.verdict === 'confident' ? r.ranked[0].node.id : null,
        best: r.ranked[0]?.node.id ?? null, count: matches.length, reason: r.reason };
}
function quality(cases) {
    const rows = cases.map((c) => ({ id: c.id, family: c.family,
        expected: c.expected, before: run(old, c), after: run(next, c) }));
    const labeled = rows.length > 0 && rows.every((r) => r.expected);
    const summarize = (side) => ({ count: rows.length,
        correct: labeled ? rows.filter((r) => r[side].verdict === r.expected.verdict
            && r[side].selected === r.expected.selected).length : null,
        unsupportedSelections: labeled ? rows.filter((r) => r.expected.verdict === 'abstain'
            && r[side].verdict === 'confident').length : null,
        abstained: rows.filter((r) => r[side].verdict === 'abstain').length,
        selected: rows.filter((r) => r[side].verdict === 'confident').length,
    });
    return { rows, before: summarize('before'), after: summarize('after'),
        changedVerdicts: rows.filter((r) => r.before.verdict !== r.after.verdict).length,
        changedRankLeaders: rows.filter((r) => r.before.best !== r.after.best).length };
}
function timings(cases, rounds, repeat) {
    for (const c of cases) { run(old, c); run(next, c); }
    const samples = { before: [], after: [] }, totals = { before: 0, after: 0 };
    for (let round = 0; round < rounds; round++) {
        for (let i = 0; i < cases.length; i++) {
            // Rotate cases and alternate engine order to bound warmup/order bias.
            const c = cases[(i + round * 37) % cases.length];
            for (const side of (i + round) % 2 ? ['after', 'before'] : ['before', 'after']) {
                const engine = side === 'before' ? old : next;
                const start = performance.now();
                for (let n = 0; n < repeat; n++) run(engine, c);
                const elapsed = (performance.now() - start) / repeat;
                samples[side].push(elapsed); totals[side] += elapsed;
            }
        }
    }
    const stats = (side) => {
        const sorted = samples[side].sort((a, b) => a - b);
        return { p50_ms: sorted[Math.floor(sorted.length * 0.5)],
            p95_ms: sorted[Math.floor(sorted.length * 0.95)],
            mean_ms: totals[side] / sorted.length, measurements: sorted.length };
    };
    return { rounds, repeat, before: stats('before'), after: stats('after') };
}
const result = { schema: 'grafly.circuit.paired.v1', node: process.version,
    createdAt: new Date().toISOString(), baseline, candidate, inputs,
    contractHash: digest(JSON.stringify(contract)),
    contract: quality(contract), realReplay: quality(real),
    contractTiming: timings(contract, 15, 10), realTiming: timings(real, 7, 1),
    limits: ['Contract cases are ten generated families, not 200 independent user requests.',
        'Real replay has no intent labels: verdict changes are not measured accuracy.',
        'Timing includes symbol resolution and circuit judgment; excludes process startup, I/O and output rendering.',
        'No LLM tokens, provider cost, compression ratio or live session quality measured.'] };
for (const [path, hash] of Object.entries(inputs)) assert.equal(digest(readFileSync(path)), hash, path);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, contract: { before: result.contract.before,
    after: result.contract.after }, real: { count: real.length,
    beforeAbstained: result.realReplay.before.abstained, afterAbstained: result.realReplay.after.abstained,
    changedRankLeaders: result.realReplay.changedRankLeaders },
    contractTiming: result.contractTiming, realTiming: result.realTiming }));
