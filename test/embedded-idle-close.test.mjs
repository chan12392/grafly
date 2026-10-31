import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { contextDirFor } from '../dist/context/node-file.js';
import { buildGraph } from '../dist/graph/build.js';
import { readXerjState, syncXerj } from '../dist/search/xerj.js';
import { closeIdleEmbedded, embeddedBinding, openEmbedded } from '../dist/search/embedded.js';

test('an idle embedded reader is closed so its repository can be moved', { timeout: 120000 }, async t => {
    try {
        if (typeof embeddedBinding().XerjIndex.prototype.close !== 'function') return t.skip('native binary predates close()');
    } catch (error) { return t.skip(error.message); }
    const base = mkdtempSync(join(tmpdir(), 'grafly-embedded-idle-'));
    t.after(() => {
        assert.equal(dirname(resolve(base)), resolve(tmpdir()));
        rmSync(base, { recursive: true, force: true });
    });
    const root = join(base, 'repo'), moved = join(base, 'moved');
    mkdirSync(root);
    writeFileSync(join(root, 'alpha.js'), 'export function alphaHandler() { return 1; }\n');
    await buildGraph(root);
    const outDir = contextDirFor(root);
    await syncXerj(root, outDir, 'embedded');
    closeIdleEmbedded(0);                                   // start from no open reader
    assert.ok(openEmbedded(outDir, readXerjState(outDir)).count > 0);
    if (process.platform === 'win32') {
        // The mapped index files pin the repository while the reader is open...
        assert.throws(() => renameSync(root, moved));
        assert.equal(closeIdleEmbedded(60 * 60 * 1000), 0, 'a recently used reader stays open');
    }
    // ...and closing the idle reader releases them.
    assert.equal(closeIdleEmbedded(0), 1);
    renameSync(root, moved);
    assert.ok(existsSync(moved) && !existsSync(root));
});
