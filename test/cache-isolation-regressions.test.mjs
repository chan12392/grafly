import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPath } from '../dist/tool-output/output.js';
import { routeHook } from '../dist/tool-output/route.js';

const cli = join(process.cwd(), 'dist/cli.js');
const light = join(process.cwd(), 'dist/tool-output/cli.js');
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'grafly-cache-regression-'));
    mkdirSync(join(dir, '.grafly', '.graph'), { recursive: true });
    writeFileSync(join(dir, '.grafly', '.graph', 'wiring.json'), '{}');
    return dir;
}
function run(dir, args, entry = cli, extraEnv = {}) {
    const r = spawnSync(process.execPath, [entry, ...args], {
        windowsHide: true, cwd: dir, encoding: 'utf8', env: { ...process.env, GRAFLY_SESSION_ID: '', ...extraEnv },
    });
    assert.equal(r.status, 0, r.stderr);
    return r;
}

test('grep preserves case, whitespace and literal quotes after a miss', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'file.ts'), 'export const helper = "a  b";\n');
    run(dir, ['build']);
    for (const [miss, hit] of [['HELPER', 'helper'], ['a b', 'a  b'], ['"helper"', 'helper']]) {
        run(dir, ['grep', miss, '--fixed', '--no-refresh']);
        const result = run(dir, ['grep', hit, '--fixed', '--no-refresh']);
        assert.match(result.stdout, /1 hits/);
        assert.doesNotMatch(result.stderr, /dead-end hit/);
    }
});

test('grep sees rebuilt files and edits to non-newest source files', () => {
    const dir = fixture(), a = join(dir, 'a.ts'), b = join(dir, 'b.ts');
    writeFileSync(a, 'export const initial = 1;\n');
    run(dir, ['build']);
    writeFileSync(b, 'export const newlyIndexed = 2;\n');
    run(dir, ['grep', 'newlyIndexed', '--fixed', '--no-refresh']);
    run(dir, ['build']);
    assert.match(run(dir, ['grep', 'newlyIndexed', '--fixed']).stdout, /1 hits/);
    const future = new Date(Date.now() + 86400000);
    utimesSync(b, future, future);
    run(dir, ['grep', 'newSymbol', '--fixed', '--no-refresh']);
    writeFileSync(a, 'export const newSymbol = 1;\n');
    assert.match(run(dir, ['grep', 'newSymbol', '--fixed', '--no-refresh']).stdout, /1 hits/);
});

test('deletions mixed with edits or equal-length insertions return a complete file', () => {
    for (const insert of [false, true]) {
        const dir = fixture(), file = join(dir, 'file.js');
        const original = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`);
        writeFileSync(file, original.join('\n'));
        readPath(file, { sessionId: 'test' });
        const next = [...original]; next.splice(5, 1);
        if (insert) next.splice(20, 0, 'const added = 999;');
        else next[19] = 'const v20 = 999;';
        writeFileSync(file, next.join('\n'));
        const out = readPath(file, { sessionId: 'test' });
        assert.match(out, /complete=true/);
        assert.equal(out.slice(out.indexOf('\n') + 1), next.join('\n'));
        assert.match(readPath(file, { sessionId: 'test' }), /unchanged since/);
    }
});

test('native gates require a complete read in the same request session and host', () => {
    const dir = fixture(), file = join(dir, 'file.js');
    writeFileSync(file, 'const value = 1;\n');
    const input = session_id => ({ session_id, tool_name: 'read', tool_input: { file_path: file }, cwd: dir });
    assert.deepEqual(routeHook('devin', input('A')), {});
    assert.deepEqual(routeHook('devin', input('A')), {}, 'pre-tool attempts are not proof of delivery');
    readPath(file, { sessionId: 'devin:A' });
    assert.deepEqual(routeHook('devin', input('B')), {});
    assert.deepEqual(routeHook('codex', input('A')), {});
    assert.equal(routeHook('devin', input('A')).hookSpecificOutput.permissionDecision, 'deny');
    assert.deepEqual(routeHook('devin', input('A')), {}, 'retry passes');
    assert.deepEqual(routeHook('devin', input(undefined)), {});
    assert.deepEqual(routeHook('devin', { ...input('A'), tool_input: { file_path: file, offset: 0, limit: 1 } }), {});
    writeFileSync(file, 'const changed = 2;\n');
    assert.deepEqual(routeHook('devin', input('A')), {}, 'changed content passes');
    assert.match(readPath(file, { sessionId: 'devin:A' }), /const changed/);
    assert.match(readPath(file, { sessionId: null }), /const changed/);
});

test('both CLI entrypoints carry session identity and support a fresh read', () => {
    const dir = fixture(); writeFileSync(join(dir, 'file.js'), 'const value = 1;\n');
    for (const [i, entry] of [cli, light].entries()) {
        const args = ['read', 'file.js', '--session-id', `reader-${i}`];
        assert.match(run(dir, args, entry).stdout, /const value/);
        assert.match(run(dir, args, entry).stdout, /unchanged since/);
        assert.match(run(dir, [...args, '--fresh'], entry).stdout, /const value/);
    }
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'sh';
    const flag = process.platform === 'win32' ? '-Command' : '-c';
    for (const [i, entry] of [cli, light].entries()) {
        const args = ['run', '--session-id', `shell-${i}`, '--', shell, flag, 'cat file.js'];
        assert.match(run(dir, args, entry).stdout, /const value/);
        assert.equal(run(dir, args, entry).stdout.trim(), 'const value = 1;', 'shell wrappers stay raw');
        const raw = run(dir, args, entry, { GRAFLY_TOOL_OUTPUT: '0' });
        assert.equal(raw.stdout.trim(), 'const value = 1;');
        assert.doesNotMatch(raw.stdout, /grafly/);
    }
});

test('shell routing passes namespaced identities without changing host arguments', () => {
    for (const [host, tool] of [['codex', 'exec_command'], ['devin', 'exec'], ['hermes', 'terminal']]) {
        const out = routeHook(host, { session_id: 'same-id', tool_name: tool,
            tool_input: { command: 'cat file.js', timeout: 10 }, permission_mode: 'bypassPermissions' });
        const args = host === 'hermes' ? out.args : out.hookSpecificOutput.updatedInput;
        assert.ok(args.command.includes(`'--session-id' '${host}:same-id'`));
        assert.equal(args.timeout, 10);
    }
});

test('a routed command with no host identity cannot inherit another session cache', () => {
    const dir = fixture(); writeFileSync(join(dir, 'file.js'), 'const value = 1;\n');
    readPath(join(dir, 'file.js'), { sessionId: 'inherited-session' });
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'sh';
    const out = routeHook('codex', { tool_name: 'exec_command', permission_mode: 'bypassPermissions',
        tool_input: { command: 'cat file.js' }, shell: process.platform === 'win32' ? 'powershell' : 'bash' });
    const command = out.hookSpecificOutput.updatedInput.command;
    const result = spawnSync(shell, [process.platform === 'win32' ? '-Command' : '-c', command], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, GRAFLY_SESSION_ID: 'inherited-session' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /const value/);
    assert.doesNotMatch(result.stdout, /unchanged since/);
});
