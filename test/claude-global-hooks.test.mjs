import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { installClaudeGlobal } from '../dist/hosts/claude-global.js';
import { classifyToolUse } from '../dist/claude/session-metrics.js';
import { staleBanner } from '../dist/context/check.js';

function home(t) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-claude-home-'));
    t.after(() => {
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(join(root, '.claude'));
    return root;
}
const commands = (settings, event) => (settings.hooks[event] ?? []).flatMap(b => b.hooks.map(h => h.command));

test('user-level Claude install wires the agent shim, PowerShell savings and the skill', t => {
    const root = home(t);
    const settingsPath = join(root, '.claude', 'settings.json');
    const devin = '"node" "C:/x/.config/devin/hooks/grafly-devin-hook.cjs"';
    writeFileSync(settingsPath, JSON.stringify({
        model: 'keep-me',
        hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'other-start' }] }, { hooks: [{ type: 'command', command: `${devin} session-start` }] }],
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${devin} prompt` }] }],
            PreToolUse: [{ hooks: [{ type: 'command', command: 'guard' }] }, { hooks: [{ type: 'command', command: `${devin} pre-tool` }] }],
        },
    }));
    const planned = installClaudeGlobal(root, { apply: false });
    assert.ok(planned.some(w => w.action === 'updated'));
    assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks.PreToolUse.length, 2, 'dry run writes nothing');
    assert.ok(!existsSync(join(root, '.claude', 'skills', 'grafly', 'SKILL.md')));

    installClaudeGlobal(root);
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(s.model, 'keep-me');
    assert.ok(existsSync(`${settingsPath}.grafly-bak`));
    const agent = join(root, '.claude', 'helpers', 'grafly-devin-hook.cjs').replaceAll('\\', '/');
    assert.deepEqual(commands(s, 'SessionStart'), ['other-start', `node "${agent}" session-start`]);
    assert.deepEqual(commands(s, 'UserPromptSubmit'), [`node "${agent}" prompt`]);
    assert.deepEqual(commands(s, 'PreToolUse'), ['guard'], 'the no-op Devin pre-tool entry is retracted');
    const savings = s.hooks.PostToolUse.find(b => b.hooks.some(h => h.command.endsWith(' tool-savings')));
    assert.match(savings.matcher, /\bPowerShell\b/);
    assert.ok(commands(s, 'Stop').some(c => c.endsWith('grafly-hooks.cjs" stop')));
    assert.ok(existsSync(join(root, '.claude', 'helpers', 'grafly-devin-hook.cjs')));
    assert.match(readFileSync(join(root, '.claude', 'skills', 'grafly', 'SKILL.md'), 'utf8'), /^name: grafly$/m);

    assert.ok(installClaudeGlobal(root).every(w => w.action === 'unchanged'), 'reconcile converges');
});

test('PowerShell grafly calls count as grafly reads', () => {
    assert.equal(classifyToolUse('PowerShell', 'grafly ask "x" --source'), 'graft');
    assert.equal(classifyToolUse('PowerShell', 'Get-Content a.js'), null);
});

test('stale banner names the command that actually clears it', () => {
    const banner = staleBanner({ missing: 2, total: 9 });
    assert.match(banner, /grafly build --deep/);
    assert.match(banner, /2 of 9/);
});
