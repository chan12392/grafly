/**
 * Multi-host init: write each selected host's instruction file.
 * Selection = explicit ids > all > detected. Claude Code is handled
 * separately by src/claude/init.ts (hooks + statusline + skill).
 */
import { statSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { HOSTS, detectHosts } from './registry.js';
import { upsertSection } from './sections.js';
import { registerMcpConfigs } from './mcp-config.js';
import { installCodexHooks } from './codex-hooks.js';
import { installCursorHooks } from './cursor-hooks.js';
import { installAntigravitySkill } from './antigravity.js';
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
function writeOwned(path, content) {
    if (existsSync(path) && readFileSync(path, 'utf8') === content)
        return 'unchanged';
    mkdirSync(dirname(path), { recursive: true });
    const existed = existsSync(path);
    writeFileSync(path, content);
    return existed ? 'replaced' : 'created';
}
export function runHostsInit(repo, opts = {}) {
    const home = opts.home ?? homedir();
    const probe = probeFor(home, repo);
    let selected;
    let unknown = [];
    if (opts.agents !== undefined) {
        const byId = new Map(HOSTS.map((h) => [h.id, h]));
        selected = opts.agents.flatMap((id) => byId.get(id) ?? []);
        unknown = opts.agents.filter((id) => !byId.has(id));
    }
    else if (opts.all) {
        selected = HOSTS;
    }
    else {
        selected = detectHosts(probe);
    }
    const written = [];
    for (const host of selected) {
        const path = join(repo, host.relPath);
        const action = host.kind === 'owned'
            ? writeOwned(path, host.content())
            : upsertSection(path, host.content()).action;
        written.push({ id: host.id, path, action });
    }
    const skipped = HOSTS.filter((h) => !selected.includes(h)).map((h) => h.id);
    const mcp = opts.mcp === false
        ? []
        : registerMcpConfigs(repo, selected.map((h) => h.id), { home, global: opts.global });
    // The Codex hook targets are user-level (~/.codex), so --no-global suppresses them.
    const hooks = opts.hooks === false || opts.global === false || !selected.some((h) => h.id === 'agents')
        ? []
        : installCodexHooks(home);
    // Cursor's hooks are repo-local (.cursor/hooks.json), matching the Cursor-only,
    // no-global posture — so --no-global does NOT suppress them; only --no-hooks does.
    const cursorHooks = opts.hooks === false || !selected.some((h) => h.id === 'cursor')
        ? []
        : installCursorHooks(repo);
    // Antigravity's skill is a global write too, so --no-global suppresses it as well.
    const antigravitySkill = opts.global === false || !selected.some((h) => h.id === 'antigravity')
        ? []
        : installAntigravitySkill(home);
    return { written, skipped, unknown, mcp, hooks: [...hooks, ...cursorHooks, ...antigravitySkill] };
}
//# sourceMappingURL=init.js.map