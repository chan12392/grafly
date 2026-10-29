import test from 'node:test';
import assert from 'node:assert/strict';
import { literalArgv, routeInput, routeHook } from '../dist/tool-output/route.js';
// The ambient host may disable or reroute tool output; these tests own that configuration.
for (const key of Object.keys(process.env))
    if (key === "GRAFLY_TOOL_OUTPUT" || key === "GRAFLY_NO_TOOL_ROUTE" || key.startsWith("GRAFLY_MC")) delete process.env[key];

test('only the three requested hosts route literal shell commands', () => {
    for (const [host, tool] of [['codex', 'Bash'], ['devin', 'exec'], ['hermes', 'terminal']]) {
        const args = { command: 'rg -n "some pattern" "folder with spaces"', workdir: 'C:/work', timeout: 7 };
        const out = routeInput(host, tool, args);
        assert.match(out.command, /cli\.js.*'run' '--' 'rg'/);
        assert.equal(out.workdir, args.workdir); assert.equal(out.timeout, 7);
        assert.equal(routeInput(host, tool, out), null, 'no double wrap');
    }
    for (const host of ['claude', 'grok', 'gemini', 'unknown']) assert.equal(routeInput(host, 'Bash', { command: 'rg foo .' }), null);
});
test('complex shell, native read, interactive and modifying commands stay with host', () => {
    for (const command of ['rg foo .; Remove-Item x', 'rg foo . | head', 'rg "$secret" .', 'rg $(cmd) .', 'git reset --hard', 'cd x && rg a .', 'rg x *.js', 'rg x .\nGet-Content secret'])
        assert.equal(routeInput('devin', 'exec', { command }), null, command);
    for (const property of ['pty', 'tty', 'background']) assert.equal(routeInput('hermes', 'terminal', { command: 'rg a .', [property]: true }), null);
    // A fresh session id keeps the conditional-read gate from consulting
    // whatever a concurrent real session recorded in .grafly/.cache.
    process.env.GRAFLY_SESSION_ID = `test-route-${process.pid}`;
    try { assert.deepEqual(routeHook('devin', { tool_name: 'read', tool_input: { file_path: 'README.md' } }), {}); }
    finally { delete process.env.GRAFLY_SESSION_ID; }
});
test('quoting preserves literals and host contracts preserve approval mode', () => {
    assert.deepEqual(literalArgv("rg 'it''s' 'C:\\space dir'", 'powershell'), ['rg', "it's", 'C:\\space dir']);
    assert.deepEqual(literalArgv("grep 'a b' file", 'bash'), ['grep', 'a b', 'file']);
    assert.equal(literalArgv('grep "$(touch x)" file', 'bash'), null);
    const input = { tool_name: 'Bash', tool_input: { command: 'rg foo .' } };
    assert.deepEqual(routeHook('codex', { ...input, permission_mode: 'default' }), {});
    assert.equal(routeHook('codex', { ...input, permission_mode: 'bypassPermissions' }).hookSpecificOutput.permissionDecision, 'allow');
    const devin = routeHook('devin', { ...input, tool_name: 'exec' });
    assert.equal(devin.decision, undefined); assert.equal(devin.hookSpecificOutput.permissionDecision, undefined);
    assert.ok(!devin.hookSpecificOutput.updatedInput.command.startsWith('& '), 'Devin exec uses bash on Windows too');
    assert.equal(routeHook('hermes', { ...input, tool_name: 'terminal', shell: 'bash' }).action, 'modify');
});
