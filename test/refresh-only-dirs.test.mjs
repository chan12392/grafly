// An auto-refresh keeps a `--only-dir` build's whitelist even when the
// fingerprint is gone — its file is keyed per extractor stamp, so an upgrade
// (new stamp) leaves no readable fingerprint behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph } from '../dist/graph/build.js';
import { ensureFreshGraph } from '../dist/graph/refresh.js';
import { readGraph, wiringPath } from '../dist/graph/write.js';

test('refresh after a lost fingerprint stays inside --only-dir', async t => {
    const root = mkdtempSync(join(tmpdir(), 'grafly-onlydir-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const put = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
    put('src/a.ts', 'export function inside() { return 1; }\n');
    put('other/b.ts', 'export function outside() { return 2; }\n');
    await buildGraph(root, { onlyDirs: ['src'] });
    const cache = join(root, '.grafly', '.cache');
    for (const f of readdirSync(cache)) if (f.startsWith('fingerprint.')) rmSync(join(cache, f));
    assert.equal((await ensureFreshGraph(root)).refreshed, true);
    const paths = readGraph(wiringPath(join(root, '.grafly'))).nodes.map(n => n.path);
    assert.ok(paths.includes('src/a.ts'));
    assert.ok(!paths.includes('other/b.ts'), paths.join(','));
});
