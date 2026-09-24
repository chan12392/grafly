// Reproduce paired candidate retention through the CLI and workspace surfaces.
// node scripts/evaluate-circuit-surfaces.mjs BASELINE OUTPUT
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
const [baselineArg, outputArg] = process.argv.slice(2);
assert.ok(baselineArg && outputArg, 'BASELINE OUTPUT required');
process.env.GRAFLY_CIRCUIT_LOG = '0';
delete process.env.GRAFLY_WEIGHTS;
delete process.env.GRAFLY_ABSTAIN;
const candidate = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = resolve(baselineArg), output = resolve(outputArg);
mkdirSync(dirname(output), { recursive: true });
const root = mkdtempSync(join(dirname(output), 'surface-fixture-'));
const engines = {};
for (const [side, dir] of Object.entries({ before: baseline, after: candidate })) {
    engines[side] = { dir, ...(await import(pathToFileURL(join(dir, 'dist/graph/workspace.js')))) };
}
const rows = [];
for (const family of ['equal', 'popularity']) {
    const workspace = join(root, family), child = join(workspace, 'child');
    mkdirSync(child, { recursive: true });
    for (const name of ['a', 'b']) writeFileSync(join(child, `${name}.js`),
        'export function helper() { return 1; }\n');
    if (family === 'popularity') writeFileSync(join(child, 'uses.js'),
        'import {helper} from "./a.js";\n' + Array.from({ length: 30 }, (_, i) =>
            `export function use${i}() { return helper(); }`).join('\n'));
    const built = spawnSync(process.execPath, [join(candidate, 'dist/cli.js'), 'build'],
        { cwd: child, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(built.status, 0, built.stderr);
    mkdirSync(join(workspace, 'grafly'));
    writeFileSync(join(workspace, 'grafly/workspace.json'), JSON.stringify({ version: 1, children: ['child'] }));
    for (const surface of ['cli', 'workspace']) {
        const measure = async (side) => {
            const e = engines[side], start = performance.now();
            let ids, bytes, abstained;
            if (surface === 'cli') {
                const result = spawnSync(process.execPath, [join(e.dir, 'dist/cli.js'),
                    'callers', 'helper', '--json', '--top', '1'],
                    { cwd: child, encoding: 'utf8', windowsHide: true, timeout: 30000 });
                assert.equal(result.status, 0, result.stderr);
                const data = JSON.parse(result.stdout);
                ids = data.matches.map((m) => m.symbol.path).sort();
                bytes = Buffer.byteLength(result.stdout);
                abstained = data.circuit.verdict === 'abstain';
            } else {
                const result = e.federateCallers(workspace, undefined, 'helper', { top: 1 });
                assert.equal(result.found, true, result.text);
                ids = [...result.text.matchAll(/helper · function · ([ab]\.js):/g)].map((m) => m[1]).sort();
                bytes = Buffer.byteLength(result.text);
                abstained = result.text.includes('— abstain');
            }
            return { ids, bytes, abstained, ms: performance.now() - start };
        };
        await measure('before'); await measure('after');
        const samples = { before: [], after: [] };
        for (let round = 0; round < 9; round++) for (const side of round % 2
            ? ['after', 'before'] : ['before', 'after']) samples[side].push(await measure(side));
        const stats = (side) => {
            const sorted = samples[side].map((s) => s.ms).sort((a, b) => a - b);
            return { ...samples[side][0], p50_ms: sorted[4], p95_ms: sorted[8] };
        };
        const before = stats('before'), after = stats('after');
        assert.deepEqual(after.ids, ['a.js', 'b.js']);
        assert.equal(after.abstained, true);
        rows.push({ family, surface, before, after });
    }
}
const result = { node: process.version, createdAt: new Date().toISOString(), root, rows,
    limits: ['Two generated source fixtures; no execution of their source.',
        'CLI timing includes process startup and rendering. Workspace timing is in-process wall time.',
        'Bytes are output size, not provider input tokens. More retained evidence can increase output.'] };
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, rows }));
