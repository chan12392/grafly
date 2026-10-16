import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t, failure = false) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-test-runner-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'test'));
    copyFileSync(new URL('../scripts/run-tests.mjs', import.meta.url), join(root, 'scripts', 'run-tests.mjs'));
    writeFileSync(join(root, 'test', 'environment.test.mjs'), `
import test from 'node:test';
import assert from 'node:assert/strict';
test('isolated child environment', () => {
    for (const key of ['GRAFLY_TOOL_OUTPUT', 'GRAFLY_NO_TOOL_ROUTE', 'GRAFLY_MC_HOME',
        'GRAFLY_DIR', 'GRAFT_DIR', 'GRAFLY_TEST_STDIN', 'grafly_unrecognized_setting'])
        assert.equal(process.env[key], undefined, key);
    assert.equal(process.env.GRAFLY_TEST_CODEX, 'explicit-codex');
    assert.equal(process.env.GRAFLY_TEST_PYTHON, 'explicit-python');
    assert.equal(process.env.TEST_RUNNER_SENTINEL_UNRELATED, 'preserved');
    assert.equal(process.env.GIT_CONFIG_COUNT, '2');
    assert.equal(process.env.GIT_CONFIG_VALUE_0, 'false');
    assert.equal(process.env.GIT_CONFIG_VALUE_1, 'false');
});
${failure ? "test('intentional failure', () => assert.fail('runner failure sentinel'));" : ''}
`);
    const env = { ...process.env, GRAFLY_TOOL_OUTPUT: '0', GRAFLY_NO_TOOL_ROUTE: '1',
            GRAFLY_MC_HOME: 'user-analyzer', GRAFLY_DIR: 'user-index', GRAFT_DIR: 'legacy-index',
            GRAFLY_TEST_STDIN: 'user-hook-input', grafly_unrecognized_setting: 'future-flag',
            GRAFLY_TEST_CODEX: 'explicit-codex', GRAFLY_TEST_PYTHON: 'explicit-python',
            TEST_RUNNER_SENTINEL_UNRELATED: 'preserved', GIT_CONFIG_COUNT: '0' };
    // This fixture starts a separate test runner, outside node:test's worker context.
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [join(root, 'scripts', 'run-tests.mjs')], {
        encoding: 'utf8', timeout: 15000, windowsHide: true, env,
    });
}

test('test runner isolates inherited product settings and retains explicit runtime opt-ins', t => {
    const result = fixture(t);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# pass 1\b/);
});

test('test runner preserves a failing child exit code and diagnostic output', t => {
    const result = fixture(t, true);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /runner failure sentinel/);
});
