import { contextDirFor } from '../dist/context/node-file.js';
// Local paired replay on existing indexes. No build/refresh, network or session writes.
// node scripts/evaluate-exact-symbol.mjs BASELINE_PACKAGE WORKSPACE OUTPUT_JSON
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ask } from '../dist/ask/ask.js';
import { federateAsk } from '../dist/graph/workspace.js';
import { relevantRetrieval } from '../dist/claude/format.js';

const [baselineDir, workspace, output] = process.argv.slice(2).map((p) => resolve(p));
assert.ok(baselineDir && workspace && output, 'BASELINE_PACKAGE WORKSPACE OUTPUT_JSON required');
const oldAsk = (await import(pathToFileURL(join(baselineDir, 'dist/ask/ask.js')))).ask;
const oldFederate = (await import(pathToFileURL(join(baselineDir, 'dist/graph/workspace.js')))).federateAsk;
const cases = [
    ['grafly', 'writeSession', 'dist/claude/state.js', 'persist the session cache'],
    ['grafly', 'readSession', 'dist/claude/state.js', 'load the session state'],
    ['grafly', 'relevantRetrieval', 'dist/claude/format.js', 'filter retrieval context'],
    ['grafly', 'federateAsk', 'dist/graph/workspace.js', 'combine project search results'],
    ['grafly', 'loadGraphCached', 'dist/graph/load.js', 'cache the graph from disk'],
    ['grafly', 'writeAskIndex', 'dist/ask/index-file.js', 'save the search index'],
    ['Freeable', 'hashSessionToken', 'lib/auth.ts', 'hash the session token'],
    ['Freeable', 'createSession', 'lib/auth.ts', 'create a login session'],
    ['Freeable', 'verifyPassword', 'lib/auth.ts', 'check a password'],
    ['mmm-backend', 'create_site_session', 'app/site_auth.py', 'create a site session'],
    ['mmm-backend', 'valid_site_session', 'app/site_auth.py', 'validate a site session'],
    ['morecoffee', 'assess_intent', 'morecoffee/channels/builtin/search_intents.py', 'assess search intent'],
    ['morecoffee', 'missing_facets', 'morecoffee/channels/builtin/search_intents.py', 'find missing search facets'],
];
const ordinary = [
    'Where is the session cache stored?', 'How are password hashes verified?',
    'Where is authentication configured?', 'How are project search results combined?',
    'How are search terms tokenized?', 'Where are session cookies validated?',
    'How does graph caching work?', 'How is session history compacted?',
    'Where are tool names normalized?', 'How are tests discovered?',
    'How is the workspace index loaded?', 'How are imports resolved?',
    'How is source code attached to search results?', 'Where are graph files saved?',
    'How are search scopes ranked?', 'Where is user registration implemented?',
];
const controls = ['who calls writeSession', 'what does readSession call',
    'who calls loadGraphCached', 'what does federateAsk call',
    'Where is nonexistentCacheQz917?', 'Locate src/writeSession.js',
    'writeSessionExtraQz917', 'write session'];
const children = JSON.parse(readFileSync(join(contextDirFor(workspace), 'workspace.json'), 'utf8')).children;
const candidateDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineFiles = ['dist/ask/ask.js', 'dist/ask/exact-symbol.js', 'dist/ask/fuse.js',
    'dist/ask/index-file.js', 'dist/graph/workspace.js', 'dist/claude/format.js'];
const watched = [join(contextDirFor(workspace), 'workspace.json'),
    join(workspace, '.config/devin/hooks/grafly-devin-hook.cjs'),
    ...[baselineDir, candidateDir].flatMap((root) => engineFiles.map((file) => join(root, file))),
    ...children.flatMap((child) => [join(contextDirFor(join(workspace, child)), '.graph/wiring.json'),
        join(workspace, child, '.grafly/.cache/ask-index.json')])].filter(existsSync);
const digest = () => Object.fromEntries(watched.map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]));
const before = digest();
const result = { baselineDir, workspace, node: process.version, sourceProof: [], quality: [], controls: [], timings: [], inputs: before };
const rank = (r, pointer) => {
    const index = r.hits.findIndex((h) => h.pointer === pointer);
    return index < 0 ? null : index + 1;
};
const summary = (r) => r.hits.map(({ title, pointer, exactSymbol }) => ({ title, pointer, ...(exactSymbol ? { exactSymbol } : {}) }));
for (const [project, name, path, action] of cases) {
    const child = `orca/projects/${project}`;
    const root = join(workspace, child);
    const graph = JSON.parse(readFileSync(join(contextDirFor(root), '.graph/wiring.json'), 'utf8'));
    const symbol = graph.nodes.find((n) => n.name === name && n.path === path);
    assert.ok(symbol, name);
    const [start, end] = symbol.span.match(/\d+/g).map(Number);
    const lines = readFileSync(join(root, path), 'utf8').split(/\r?\n/).slice(start - 1, end);
    assert.ok(lines.some((line) => line.includes(name)), `indexed source span is stale: ${name}`);
    const pointer = `${child}/${path}:${symbol.span}`;
    if (name === 'writeSession')
        result.writeSessionBaselineRank = rank(oldFederate(workspace, undefined,
            'Where does writeSession persist the session cache?', { limit: 100 }), pointer);
    result.sourceProof.push({ name, pointer, sourceVerified: true });
    for (const query of [`Where does ${name} ${action}?`, `${name} 함수 정의를 찾아줘`]) {
        const opts = { limit: 3 };
        const oldLocal = oldAsk(root, query, opts);
        const newLocal = ask(root, query, opts);
        const oldHome = oldFederate(workspace, undefined, query, opts);
        const newHome = federateAsk(workspace, undefined, query, opts);
        const pack = relevantRetrieval(newHome, {});
        result.quality.push({ name, query, pointer,
            localBefore: rank(oldLocal, `${path}:${symbol.span}`), localAfter: rank(newLocal, `${path}:${symbol.span}`),
            homeBefore: rank(oldHome, pointer), homeAfter: rank(newHome, pointer),
            hookIncludesTarget: Boolean(pack?.includes(pointer)), before: summary(oldHome), after: summary(newHome) });
    }
    console.log(`paired exact queries: ${result.quality.length}/${cases.length * 2}`);
}
for (const query of [...ordinary, ...controls]) {
    const oldHome = oldFederate(workspace, undefined, query, { limit: 3 });
    const newHome = federateAsk(workspace, undefined, query, { limit: 3 });
    result.controls.push({ query, identical: JSON.stringify(oldHome) === JSON.stringify(newHome),
        before: summary(oldHome), after: summary(newHome) });
}
// Warm-process paired timing, alternating order to avoid always favoring one side.
// Includes complete federation but not process startup; this is not hook latency.
for (let i = 0; i < 12; i++) {
    const query = i % 2 ? ordinary[i % ordinary.length] : result.quality[i % result.quality.length].query;
    const row = { query };
    for (const version of i % 2 ? ['after', 'before'] : ['before', 'after']) {
        const start = performance.now();
        (version === 'before' ? oldFederate : federateAsk)(workspace, undefined, query, { limit: 3 });
        row[version] = performance.now() - start;
    }
    result.timings.push(row);
}
result.inputsUnchanged = JSON.stringify(before) === JSON.stringify(digest());
const median = (values) => { const s = [...values].sort((a,b) => a-b); return (s[5] + s[6]) / 2; };
result.summary = {
    exactQueries: result.quality.length,
    localTop3Before: result.quality.filter((r) => r.localBefore).length,
    localTop3After: result.quality.filter((r) => r.localAfter).length,
    homeTop3Before: result.quality.filter((r) => r.homeBefore).length,
    homeTop3After: result.quality.filter((r) => r.homeAfter).length,
    homeTop1After: result.quality.filter((r) => r.homeAfter === 1).length,
    hookIncludesTarget: result.quality.filter((r) => r.hookIncludesTarget).length,
    unchangedControls: result.controls.filter((r) => r.identical).length,
    totalControls: result.controls.length,
    warmMedianBeforeMs: median(result.timings.map((r) => r.before)),
    warmMedianAfterMs: median(result.timings.map((r) => r.after)),
    inputsUnchanged: result.inputsUnchanged,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result.summary));
assert.ok(result.inputsUnchanged, 'existing indexes or live hook changed');
assert.equal(result.summary.homeTop3After, result.quality.length, 'exact target missing from top 3');
assert.equal(result.summary.hookIncludesTarget, result.quality.length, 'hook context omitted target');
assert.ok(result.controls.every((r) => r.identical), 'a control query changed');
