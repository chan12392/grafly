import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import safePath from '../util/safe-path.cjs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { installClaudeGlobal } from '../hosts/claude-global.js';
import { readJsonObject } from '../hosts/config-write.js';
import { mergeGraftSettings } from './settings-merge.js';
import { statuslineShim, hooksShim } from './shim-template.js';
import { skillTemplate } from './skill-template.js';
import { claudeDistDir } from './paths.js';
import { hasGraflyIndex } from '../graph/root.js';
/**
 * The files `runInit` writes — pure, no writes, so `--dry-run` and the picker
 * can report them up front. All repo-local: the Claude Code layer never writes
 * outside the project.
 */
export function claudeTargets(dir) {
    const t = (path, what, kind = 'claude') => ({ hostId: 'claude', id: 'claude', path, scope: 'repo', kind, what });
    return [
        t(join(dir, '.claude', 'settings.json'), 'Grafly statusline + hook blocks'),
        t(join(dir, '.claude', 'helpers', 'grafly-statusline.cjs'), 'statusline shim'),
        t(join(dir, '.claude', 'helpers', 'grafly-hooks.cjs'), 'hooks shim'),
        t(join(dir, '.claude', 'skills', 'grafly', 'SKILL.md'), 'Grafly skill'),
    ];
}
/**
 * Build the graph if it isn't there yet. Not Claude-specific: the wiring for any
 * host points at `grafly/`, so `grafly init` builds whichever hosts were selected —
 * this lives beside `runInit` only because that's the caller that owns `built`.
 * Best-effort; the user can always run `grafly build` (the epilogue says so).
 */
export function buildGraphIfMissing(dir, opts) {
    // `hasGraftIndex`, not just wiring.json: a workspace parent's graph IS its
    // `workspace.json` (nodes live in the children), so testing for wiring.json
    // alone would call it unbuilt and rebuild every child on each init.
    if (opts.build === false || !opts.cliPath || hasGraflyIndex(dir))
        return false;
    try {
        execFileSync(process.execPath, [opts.cliPath, 'build', '.'], { cwd: dir, stdio: 'inherit', timeout: 300000 });
        return true;
    }
    catch {
        return false;
    }
}
export function runInit(dir, opts = {}) {
    // Same list `--dry-run` and the picker report, so the two can't drift apart.
    const [settings, statusline, hooks, skill] = claudeTargets(dir).map((t) => t.path);
    for (const target of [settings, statusline, hooks, skill]) safePath.assertNoSymlinks(target, dir);
    const settingsPath = settings;
    const loaded = readJsonObject(settingsPath);
    if (loaded === 'unparseable')
        throw new Error(`Cannot initialize Grafly: ${settingsPath} is not a readable JSON object; existing settings left unchanged.`);
    const { merged, warnings } = mergeGraftSettings(loaded.root, { statusline: opts.statusline });
    mkdirSync(dirname(statusline), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
    const sl = statusline;
    const hk = hooks;
    const bakedDir = claudeDistDir(); // absolute <pkg>/dist/claude — the shims' primary resolution path
    writeFileSync(sl, statuslineShim(bakedDir));
    chmodSync(sl, 0o755);
    writeFileSync(hk, hooksShim(bakedDir));
    chmodSync(hk, 0o755);
    // Install the Grafly skill — the piece that redirects the agent to grafly/ before it
    // greps source. Overwritten each run (Grafly owns this file), like the shims above.
    const skillPath = skill;
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, skillTemplate());
    // The same wiring again, one level up in `~/.claude`, because everything above
    // this line can be erased by a `.gitignore` and lost to `git worktree add`. See
    // hosts/claude-global.ts for the failure that motivates it. Gated on the same
    // flag the other global writes use, so `--no-global` still means "nothing
    // outside this repo".
    const global = opts.global === false ? [] : installClaudeGlobal(opts.home ?? homedir());
    const built = buildGraphIfMissing(dir, opts);
    return { settingsPath, shims: [sl, hk], skill: skillPath, global, warnings, built };
}
