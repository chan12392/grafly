import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('package entrypoint loads the full CLI and preserves adjacent command registrations', () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GRAFLY|GRAFT|MC)_/i.test(key)));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/entry.js', import.meta.url)), '--help'], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', windowsHide: true, timeout: 20000,
        env: { ...env, GRAFLY_NO_DAEMON: '1', GRAFLY_JUDGMENT_CONFIG: '0', DO_NOT_TRACK: '1' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    for (const command of ['mc-runtime', 'feedback', 'run', 'read', 'output'])
        assert.match(result.stdout, new RegExp(`^\\s+${command}(?:\\s|\\[|\\()`, 'm'));
});
