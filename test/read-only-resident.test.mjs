import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { packageRoot, searchEndpoint, tryResidentSearch } from '../dist/search/client.js';

test('read-only requests skip a resident service that does not advertise read-only', async t => {
    const home = mkdtempSync(join(tmpdir(), 'grafly-readonly-ipc-'));
    const previous = process.env.GRAFLY_SEARCH_HOME;
    process.env.GRAFLY_SEARCH_HOME = home;
    let requests = 0;
    const server = createServer(socket => {
        requests++;
        socket.end(JSON.stringify({ stdout: '', stderr: '', exitCode: 0 }) + '\n');
    });
    server.listen(searchEndpoint());
    await once(server, 'listening');
    t.after(() => {
        server.close();
        if (previous === undefined) delete process.env.GRAFLY_SEARCH_HOME;
        else process.env.GRAFLY_SEARCH_HOME = previous;
        assert.equal(dirname(resolve(home)), resolve(tmpdir()));
        rmSync(home, { recursive: true, force: true });
    });
    const state = features => writeFileSync(join(home, 'state.json'), JSON.stringify({
        protocol: 1, token: 't', pid: process.pid, packageRoot, commands: ['ask', 'grep'], ...(features ? { features } : {}) }));

    state(null);
    assert.equal(await tryResidentSearch(['ask', 'symbol', '.', '--read-only']), false);
    assert.equal(requests, 0);
    assert.equal(await tryResidentSearch(['grep', 'symbol', '.']), true);  // ordinary requests still use it
    assert.equal(requests, 1);

    state(['read-only']);
    assert.equal(await tryResidentSearch(['ask', 'symbol', '.', '--read-only']), true);
    assert.equal(requests, 2);
    process.exitCode = 0;
});
