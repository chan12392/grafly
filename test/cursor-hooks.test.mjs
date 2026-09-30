import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installCursorHooks, cursorHookTargets } from '../dist/hosts/cursor-hooks.js';
import { runRetract, planRetract } from '../dist/hosts/retract.js';

function fixture(t) {
    const repo = mkdtempSync(join(tmpdir(), 'grafly-cursor-retract-'));
    // Preserve the checkout itself while uninstall prunes owned empty directories.
    writeFileSync(join(repo, 'user.txt'), 'User-owned file.\n');
    t.after(() => {
        assert.ok(resolve(repo).startsWith(resolve(tmpdir()) + sep));
        rmSync(repo, { recursive: true, force: true });
    });
    const opts = { home: join(repo, 'home'), global: false, cache: false };
    return { repo, opts, config: join(repo, '.cursor', 'hooks.json') };
}

test('Cursor uninstall plans, removes, and idempotently clears both repo-local hook files', t => {
    const { repo, opts } = fixture(t);
    installCursorHooks(repo);
    const hookPaths = cursorHookTargets(repo).map(t => t.path);
    const plan = planRetract(repo, opts);
    for (const path of hookPaths) {
        assert.equal(plan.find(t => t.path === path)?.action, 'deleted');
        assert.ok(existsSync(path), 'dry run never writes');
    }
    runRetract(repo, { ...opts, exclude: ['cursor'] });
    assert.ok(hookPaths.every(existsSync), 'init keeps hooks of selected Cursor host');
    const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'uninstall', repo, '-y', '--keep-cache', '--no-global'], {
        cwd: repo, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /fully removed/);
    assert.ok(hookPaths.every(p => !existsSync(p)));
    assert.equal(readFileSync(join(repo, 'user.txt'), 'utf8'), 'User-owned file.\n');
    assert.ok(runRetract(repo, opts).every(t => t.action === 'absent'));
});

test('Cursor removal preserves foreign direct and nested hooks, events, and settings', t => {
    const { repo, opts, config } = fixture(t);
    mkdirSync(join(repo, '.cursor'));
    const foreign = { version: 1, custom: 'keep', hooks: {
        postToolUse: [{ matcher: 'Read', timeout: 50, hooks: [
            { type: 'command', command: 'foreign-before' },
            { type: 'command', command: 'node /old/grafly-hooks.cjs cursor-post-tool' },
            { type: 'command', command: 'foreign-after' },
        ] }, { command: 'foreign-direct' }],
        sessionEnd: [{ command: 'foreign-session' }], beforeSubmitPrompt: [{ command: 'foreign-prompt' }],
    } };
    writeFileSync(config, JSON.stringify(foreign));
    installCursorHooks(repo);
    runRetract(repo, opts);
    foreign.hooks.postToolUse[0].hooks.splice(1, 1);
    // Installation may split a mixed group to preserve handler execution order.
    // Compare each remaining handler with its inherited group metadata.
    const flatten = entries => entries.flatMap(entry => {
        if (!Array.isArray(entry.hooks)) return [entry];
        const { hooks, ...metadata } = entry;
        return hooks.map(hook => ({ ...metadata, hooks: [hook] }));
    });
    const actual = JSON.parse(readFileSync(config, 'utf8'));
    actual.hooks.postToolUse = flatten(actual.hooks.postToolUse);
    foreign.hooks.postToolUse = flatten(foreign.hooks.postToolUse);
    assert.deepEqual(actual, foreign);
    assert.equal(existsSync(join(repo, '.cursor', 'hooks', 'grafly-hooks.cjs')), false);
});

test('Cursor removal reports malformed JSON and preserves its original bytes', t => {
    const { repo, opts, config } = fixture(t);
    installCursorHooks(repo);
    const broken = '{ user is still editing this config';
    writeFileSync(config, broken);
    const result = runRetract(repo, opts);
    assert.equal(result.find(t => t.path === config).action, 'skipped-unparseable');
    assert.equal(readFileSync(config, 'utf8'), broken);
});
