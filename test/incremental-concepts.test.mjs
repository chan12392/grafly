import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { buildContext } from '../dist/context/build.js';
import { readNodes } from '../dist/context/node-file.js';
test('Deep preserves unrelated concept bytes and human notes; failed batches preserve the prior map', async t => {
    const root = mkdtempSync(join(tmpdir(), 'grafly-incremental-'));
    t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
    writeFileSync(join(root, 'a.js'), 'export const apple = 1;');
    writeFileSync(join(root, 'b.js'), 'export const banana = 1;');
    let fail = false; const summarized = [], synthesized = [];
    const opts = { incremental: true, model: 'fixture', concurrency: 2,
        summarizer: { summarize: async (code, { path }) => { summarized.push(path); return code; } },
        synthesizer: { synthesize: async files => { synthesized.push(files.map(f => f.path)); if (fail) throw new Error('offline');
            return files.map(f => ({ name: f.path.slice(0, 1), type: 'concept', summary: f.summary, sources: [f.path], links: [] })); } } };
    assert.equal((await buildContext(root, opts)).nodes, 2);
    const b = join(root, '.grafly/b.md'), a = join(root, '.grafly/a.md');
    writeFileSync(b, readFileSync(b, 'utf8') + '\nHuman notes remain.\n');
    const original = readFileSync(b, 'utf8');
    summarized.length = 0; synthesized.length = 0;
    writeFileSync(join(root, 'a.js'), 'export const apple = 2;');
    assert.equal((await buildContext(root, opts)).nodes, 2);
    assert.deepEqual(summarized, ['a.js']); assert.deepEqual(synthesized, [['a.js']]);
    assert.equal(readFileSync(b, 'utf8'), original);
    const before = readFileSync(a, 'utf8');
    fail = true; writeFileSync(join(root, 'a.js'), 'export const apple = 3;');
    assert.ok((await buildContext(root, opts)).errors.length);
    assert.equal(readFileSync(a, 'utf8'), before); assert.equal(readFileSync(b, 'utf8'), original);
    fail = false;
    // Deletion removes stale active claims but archives the complete old concept.
    rmSync(join(root, 'a.js'));
    assert.equal((await buildContext(root, opts)).nodes, 1);
    const history = join(root, '.grafly/.cache/concept-history');
    assert.equal(readFileSync(join(history, readdirSync(history)[0], 'a.md'), 'utf8'), before);
});
test('deleting a concept removes incoming stale links and keeps human notes', async t => {
    const root = mkdtempSync(join(tmpdir(), 'grafly-incremental-links-'));
    t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
    writeFileSync(join(root, 'a.js'), 'export const a=1;');
    writeFileSync(join(root, 'b.js'), 'export const b=1;');
    const opts = { incremental: true, model: 'fixture', summarizer: { summarize: async s => s },
        synthesizer: { synthesize: async files => files.map(f => ({ name: f.path[0], type:'concept', summary:f.summary,
            sources:[f.path], links:f.path==='b.js' ? [{to:'a',relation:'uses',description:'fixture'}] : [] })) } };
    await buildContext(root, opts);
    const b=join(root,'.grafly/b.md'); writeFileSync(b,readFileSync(b,'utf8')+'\nPreserve this note.\n');
    rmSync(join(root,'a.js'));
    await buildContext(root,opts);
    assert.deepEqual(readNodes(join(root,'.grafly'))[0].links,[]);
    assert.match(readFileSync(b,'utf8'),/Preserve this note/);
});
