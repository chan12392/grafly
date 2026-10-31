/**
 * User-level install for Claude Code: the copy of graft's wiring that lives
 * outside every repo.
 *
 * Why this exists. Everything `grafly init` writes for Claude Code lands *in* the
 * repo — `.claude/settings.json`. A `.gitignore` is free to ignore it, and
 * `git worktree add` checks out tracked files only, so a worktree of such a repo
 * starts with graft's shims present and nothing that *points at* them. No
 * settings.json means no SessionStart hook: graft is absent, silently, in a tree
 * that looks correctly wired.
 *
 * So the fix cannot live in the repo. `~/.claude/` is not in anyone's working tree,
 * no `.gitignore` reaches it, and Claude Code reads it for every project — worktrees
 * included. Codex has been installed this way from the start (see ./codex-hooks.ts,
 * whose own note says the entries "fire in every repo opened with Codex, not just
 * this one"); Claude Code was the one host graft wired repo-only. This module closes
 * that gap, and is a deliberate mirror of that file.
 *
 * The repo-level writes stay exactly as they were. A project that has its own
 * settings keeps using them; this is the floor underneath, not a replacement.
 */
import { copyFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hooksShim } from '../claude/shim-template.js';
import { claudeDistDir } from '../claude/paths.js';
import { mergeGraftHooks } from '../claude/settings-merge.js';
import { skillTemplate } from '../claude/skill-template.js';
import { toPosixPath } from '../util/paths.js';
import { readJsonObject, writeOwned, planOwned, mergeGraftHookEntries } from './config-write.js';
import { devinShimSource } from './devin-hooks.js';

/** The directory the user-level shim lives in — the base every hook command names. */
export function globalHelpersDir(home) {
    return join(home, '.claude', 'helpers');
}
/**
 * The files a user-level install would touch — pure, no writes, so `--dry-run` and
 * the picker can report them up front. Both are scoped 'global': they apply to
 * every project opened with Claude Code, not just this one.
 */
export function claudeGlobalTargets(home) {
    const g = (id, path, kind, what) => ({ hostId: 'claude', id, path, scope: 'global', kind, what });
    return [
        g('claude-global-shim', join(globalHelpersDir(home), 'grafly-hooks.cjs'), 'hook', 'hooks shim (user level)'),
        g('claude-global-hooks', join(home, '.claude', 'settings.json'), 'hook', 'SessionStart / UserPromptSubmit / PostToolUse / Stop'),
        g('claude-global-agent-shim', join(globalHelpersDir(home), 'grafly-devin-hook.cjs'), 'hook', 'session-start/prompt hook shim (user level)'),
        g('claude-global-skill', join(home, '.claude', 'skills', 'grafly', 'SKILL.md'), 'skill', 'Grafly skill (user level)'),
    ];
}
/** Merge graft's hook blocks into a settings file, preserving everything else. */
function upsertGlobalHooks(id, path, helpers, agentShim, apply) {
    const loaded = readJsonObject(path);
    if (loaded === 'unparseable')
        return { id, path, action: 'skipped-unparseable' };
    const { root: existing, existed } = loaded;
    const before = JSON.stringify(existing);
    const { merged } = mergeGraftHooks(existing, helpers, agentShim);
    // Claude Code has no PreToolUse route (route-hook serves codex/devin/hermes
    // only), so a copied Devin pre-tool entry only spawns node on every call.
    if (Array.isArray(merged.hooks.PreToolUse))
        merged.hooks.PreToolUse = mergeGraftHookEntries(merged.hooks.PreToolUse, []);
    if (JSON.stringify(merged) === before)
        return { id, path, action: 'unchanged' };
    if (apply) {
        mkdirSync(dirname(path), { recursive: true });
        // The file carries every Claude Code setting, not just hooks.
        if (existed)
            copyFileSync(path, `${path}.grafly-bak`);
        writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
    }
    return { id, path, action: existed ? 'updated' : 'created' };
}
/**
 * Install the user-level copy: both shims, the skill, and the hook entries that
 * call the shims. Session-start/prompt run the devin-hook shim, as on Codex;
 * PostToolUse/Stop run the generated shim. `apply: false` only plans.
 *
 * The shims are written to `home` and the hook commands name them by absolute path, for
 * the reason the repo form can't be reused: `${CLAUDE_PROJECT_DIR}/.claude/helpers/`
 * resolves inside whatever project is open, and the whole point is to work in one
 * that has no such file. `hooksShim(claudeDistDir())` bakes in the installed
 * package's `dist/`, exactly as the Codex install does.
 *
 * Best-effort by contract, like every other writer here: a failure is reported as an
 * action, never raised, so a bad `~/.claude.json` can't fail a `grafly init`.
 */
export function installClaudeGlobal(home, { apply = true } = {}) {
    const [shim, settings, agent, skill] = claudeGlobalTargets(home);
    const write = apply ? writeOwned : planOwned;
    const out = [];
    for (const [t, content] of [[shim, () => hooksShim(claudeDistDir())], [agent, devinShimSource]]) {
        try {
            out.push(write(t.id, t.path, content(), 0o755));
        }
        catch {
            out.push({ id: t.id, path: t.path, action: 'skipped-unparseable' });
        }
    }
    // The skill is what points the agent at grafly before Read/Grep; repo-level
    // `init` writes one per repo, this copy covers every other indexed repo.
    try {
        out.push(write(skill.id, skill.path, skillTemplate()));
    }
    catch {
        out.push({ id: skill.id, path: skill.path, action: 'skipped-unparseable' });
    }
    // Only wire the hooks once the shims they call are actually on disk — a hook
    // entry pointing at a missing file is an error in every session, which is a
    // worse failure than not installing.
    if (out.slice(0, 2).every((w) => w.action !== 'skipped-unparseable')) {
        try {
            // Posix form in the command string: `join` gives backslashes on Windows and
            // the template appends `/grafly-hooks.cjs`, so the raw path produces a mixed
            // `C:\Users\…\helpers/grafly-hooks.cjs`. Node accepts forward slashes on
            // Windows, so one separator throughout is both correct and readable.
            out.push(upsertGlobalHooks(settings.id, settings.path, toPosixPath(globalHelpersDir(home)), toPosixPath(agent.path), apply));
        }
        catch {
            out.push({ id: settings.id, path: settings.path, action: 'skipped-unparseable' });
        }
    }
    return out;
}
