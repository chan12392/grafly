/**
 * What `graft init` *would* write, computed before anything is written.
 *
 * The picker and `--dry-run` both need the exact path list up front, so every
 * writer in the init path (instruction files, MCP configs, hooks, the Claude
 * Code layer) exposes a pure `*Targets()` function and then consumes that same
 * list to do its writing. One source of truth, so a plan can never drift from
 * what a real run touches.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import { HOSTS, detectHosts } from './registry.js';
import { mcpTargets } from './mcp-config.js';
import { hookTargets } from './codex-hooks.js';
import { cursorHookTargets } from './cursor-hooks.js';
import { antigravitySkillTargets } from './antigravity.js';
import { claudeTargets } from '../claude/init.js';
import { claudeGlobalTargets } from './claude-global.js';
function probeFor(home, repo) {
    return {
        home, repo,
        dirExists: (p) => { try {
            return statSync(p).isDirectory();
        }
        catch {
            return false;
        } },
    };
}
/** The instruction-file write for one host, derived from its registry entry. */
function instructionTarget(repo, host) {
    return {
        hostId: host.id,
        id: host.id,
        path: join(repo, host.relPath),
        scope: 'repo',
        kind: 'instruction',
        what: host.kind === 'owned' ? 'graft-owned file' : 'fenced graft section',
    };
}
/**
 * Every host graft can wire, each with the full set of files selecting it would
 * touch. Claude Code comes first — it's the deep integration and the picker's
 * default. `ids`, when given, restricts the plan to those hosts.
 */
export function planInit(repo, opts = {}) {
    const home = opts.home ?? homedir();
    const probe = probeFor(home, repo);
    const detected = new Set(detectHosts(probe).map((h) => h.id));
    const plans = [
        // Repo writes plus the user-level copy under `~/.claude` — the picker and
        // `--dry-run` render 'global' writes in their own section, so a user sees
        // what lands outside the repo before agreeing to it.
        { id: 'claude', name: 'Claude Code', detected: true, writes: [...claudeTargets(repo), ...claudeGlobalTargets(home)] },
        ...HOSTS.map((host) => ({
            id: host.id,
            name: host.name,
            detected: detected.has(host.id),
            writes: [
                instructionTarget(repo, host),
                ...mcpTargets(repo, [host.id], { home }),
                ...(host.id === 'agents' ? hookTargets(home) : []),
                ...(host.id === 'cursor' ? cursorHookTargets(repo) : []),
                ...(host.id === 'antigravity' ? antigravitySkillTargets(home) : []),
            ],
        })),
    ];
    return opts.ids ? plans.filter((p) => opts.ids.includes(p.id)) : plans;
}
/** Flatten a plan down to the writes for the selected host ids. */
export function selectedWrites(plan, ids) {
    return plan.filter((p) => ids.includes(p.id)).flatMap((p) => p.writes);
}
//# sourceMappingURL=plan.js.map