/**
 * Self-maintenance: keeping an installed graft, and the wiring it wrote, current.
 *
 * Two independent kinds of staleness, both invisible to the user today:
 *
 *   1. **Binary staleness** — they installed once and never upgraded. `graft
 *      version` would tell them, but nobody runs it. So we keep a cached,
 *      machine-global registry answer and let every entry point surface a
 *      one-line nudge from it.
 *
 *   2. **Wiring staleness** — `graft init` copies hooks, shims, skill text and
 *      rule files INTO the repo. `npm i -g` replaces the binary but touches none
 *      of them, so a repo wired by 0.7 keeps 0.7's prompts and 0.7's hook
 *      timeouts forever (see the comment on `promptAskTimeout`, which exists
 *      only to work around exactly this). A version stamp written next to the
 *      graph lets any entry point notice the skew and re-run the writes.
 *
 * Everything here is fail-soft by construction: it runs inside hooks and inside
 * the MCP server's boot path, where a throw is a broken session, and it must
 * never block on the network — the registry is only ever read from cache, and
 * the refresh happens in a detached child.
 *
 * Called from all three hosts' entry points so no editor is left out:
 *   • Claude Code   — `session-start` hook (src/claude/hooks.ts)
 *   • Cursor/Codex  — MCP server boot (src/mcp/server.ts), and any CLI command
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readJson, writeJsonAtomic, cacheDir } from './util/state.js';
import { HOSTS } from './hosts/registry.js';
import { START } from './hosts/sections.js';
import { getNpmViewVersion, readCurrentVersion } from './cli-meta.js';
import { cacheIsStale, markRulesChecked, readLink, readRulesCache } from './brain/link.js';
import { graftCliPath } from './claude/paths.js';
/**
 * The version of the graft package this code was loaded from.
 *
 * Resolved from *this* module rather than the caller's: `readCurrentVersion`
 * looks one level up from the module URL it's given, which lands on the package
 * root for `dist/upkeep.js` but misses entirely for `dist/claude/hooks.js` and
 * `dist/mcp/server.js`. Every caller asking here instead of passing its own
 * `import.meta.url` is what keeps the hook and the MCP server from reading
 * `0.0.0` and re-initing on every single session.
 */
export function runningVersion() {
    try {
        return readCurrentVersion(import.meta.url);
    }
    catch {
        return '0.0.0';
    }
}
/** How long a registry answer is considered current. A day: graft ships far less
 * often than that, and this is a nudge, not a security update. */
export const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;
/* -------------------------------------------------------------------------- */
/* version comparison                                                         */
/* -------------------------------------------------------------------------- */
/** Numeric-dotted compare of the release part only (`1.2.3-beta.1` → `1.2.3`).
 * Prerelease ordering doesn't matter here: the only question either caller asks
 * is "is the thing on npm ahead of what's on disk", and a prerelease that
 * compares equal simply produces no nudge. */
export function compareVersions(a, b) {
    const parts = (v) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
    const pa = parts(a);
    const pb = parts(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0)
            return d < 0 ? -1 : 1;
    }
    return 0;
}
export function isNewer(candidate, current) {
    if (!candidate)
        return false;
    return compareVersions(candidate, current) > 0;
}
/** Machine-global, not per-repo: "what's the latest graft" is one fact, and a
 * dev with twelve repos should cost the registry one request a day, not twelve. */
export function updateCachePath(home = homedir()) {
    return join(home, '.graft', 'update-check.json');
}
export function readUpdateCache(home) {
    return readJson(updateCachePath(home));
}
function writeUpdateCache(cache, home) {
    try {
        writeJsonAtomic(updateCachePath(home), cache);
    }
    catch { /* unwritable home — skip */ }
}
/**
 * The `graft _update-check` command body: hit the registry, store the answer.
 * Runs in a detached child so nothing user-facing ever waits on the network.
 */
export function refreshUpdateCache(home, now = Date.now()) {
    const res = getNpmViewVersion();
    const cache = { latest: res.ok ? (res.version ?? null) : null, checkedAt: now };
    writeUpdateCache(cache, home);
    return cache;
}
/** True when the cached answer is missing or older than the TTL. */
export function needsRefresh(cache, now = Date.now()) {
    return !cache || typeof cache.checkedAt !== 'number' || now - cache.checkedAt >= UPDATE_TTL_MS;
}
/**
 * Kick off a background registry check if the cache has gone stale. Touches
 * `checkedAt` first so concurrent callers (and a child that dies) don't spawn a
 * fetch per invocation. Never waits, never throws.
 *
 * Only called from long-lived or already-slow contexts (a CLI command, MCP
 * boot) — never from a hook, which reads the cache and nothing else.
 */
export function maybeRefreshInBackground(home, now = Date.now()) {
    const cache = readUpdateCache(home);
    if (!needsRefresh(cache, now))
        return false;
    writeUpdateCache({ latest: cache?.latest ?? null, checkedAt: now }, home);
    try {
        const child = spawn(process.execPath, [graftCliPath(), '_update-check'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        child.unref();
        return true;
    }
    catch {
        return false; // no spawn (sandbox, ENOMEM) — the nudge just uses the old cache
    }
}
/**
 * Refresh the attached brain's rules in a detached child, when they are stale.
 *
 * The same shape as the update check above, and for the same reason: this runs
 * inside session-start hooks and MCP boot, where waiting on the network is a
 * stalled first turn. So nothing here blocks — the child does the fetch and
 * this call returns immediately.
 *
 * Without it a brain is pulled exactly once, at `graft brain connect`, and
 * never again. That was survivable when connecting happened after the brain
 * finished building; it is not survivable now that onboarding connects DURING
 * the build, because the one pull returns an empty rulebook and nothing would
 * ever go back for the real one.
 *
 * The attempt is stamped before spawning, so a brain that is still building
 * costs one request per TTL window rather than one per command.
 */
export function maybeRefreshBrainRules(repo, now = Date.now()) {
    try {
        if (!readLink(repo))
            return false;
        const cache = readRulesCache(repo);
        if (!cacheIsStale(cache, now))
            return false;
        markRulesChecked(repo, now);
        const child = spawn(process.execPath, [graftCliPath(), '_brain-refresh', repo], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        child.unref();
        return true;
    }
    catch {
        return false; // no spawn, or an unreadable repo — the cached rules still serve
    }
}
/** One line, or nothing. Nothing is the common case — don't spend context on
 * "you're up to date". */
export function formatUpdateNudge(current, latest) {
    if (!isNewer(latest, current))
        return null;
    return `⬆ graft ${current} → ${latest} available: run \`npm i -g @nanonets/graft@latest\` (restart your agent after).`;
}
export const DEFAULT_WIRING_OPTS = { global: true, mcp: true, hooks: true, statusline: true };
/** An older stamp has no `opts`; a plain `graft init` wired everything. */
export function wiringOpts(stamp) {
    return { ...DEFAULT_WIRING_OPTS, ...(stamp?.opts ?? {}) };
}
/** Under `graft/.cache/`, beside the other derived state: git-ignored, per-clone,
 * and cheap to lose — a missing stamp just means one idempotent refresh. */
export function stampPath(repo) {
    return join(cacheDir(repo), 'wiring-stamp.json');
}
export function readStamp(repo) {
    return readJson(stampPath(repo));
}
export function writeStamp(repo, version, hosts, opts = {}, at = new Date().toISOString()) {
    try {
        writeJsonAtomic(stampPath(repo), {
            version,
            hosts: [...hosts].sort(),
            opts: { ...DEFAULT_WIRING_OPTS, ...opts },
            at,
        });
    }
    catch { /* unwritable graft/ — a refresh will just be retried next session */ }
}
/**
 * Which agents this repo is *already* wired for, read off disk rather than
 * re-detected. Detection answers "which editors does this machine have"; for a
 * refresh we need "which files did a previous init actually write" — otherwise
 * installing Windsurf once would silently add graft rules to every repo.
 */
export function wiredHostIds(repo) {
    const ids = [];
    if (existsSync(join(repo, '.claude', 'helpers', 'graft-hooks.cjs')))
        ids.push('claude');
    for (const host of HOSTS) {
        const path = join(repo, host.relPath);
        if (!existsSync(path))
            continue;
        // A shared file (AGENTS.md, GEMINI.md) counts only if graft's fenced section
        // is in it — the user may own the file for entirely unrelated reasons.
        if (host.kind === 'section') {
            try {
                if (!readFileSync(path, 'utf8').includes(START))
                    continue;
            }
            catch {
                continue;
            }
        }
        ids.push(host.id);
    }
    return ids;
}
/**
 * Re-run init's writes when the stamp and the running binary disagree.
 *
 * Deliberately narrow: it refreshes the hosts already wired, replays the flags
 * that init was given, never builds the graph (this runs at session start — a
 * rebuild there would stall the agent's first turn), and no-ops when the repo has
 * no graft wiring at all.
 */
export function reconcileWiring(repo, current, deps) {
    try {
        const stamp = readStamp(repo);
        if (stamp && stamp.version === current)
            return null;
        // The stamp is the record of *intent* (what the picker chose); disk is the
        // fallback for repos wired before stamps existed. Union, not just disk:
        // otherwise a host whose rule file went missing — deleted by hand, lost to a
        // merge, or clobbered by another tool — is silently dropped from every future
        // refresh, and that file is precisely what a refresh exists to restore.
        const onDisk = (deps.wired ?? wiredHostIds)(repo);
        const hosts = [...new Set([...(stamp?.hosts ?? []), ...onDisk])].sort();
        if (hosts.length === 0)
            return null; // never wired here — not our business
        const opts = wiringOpts(stamp);
        deps.rewrite(repo, hosts, opts);
        writeStamp(repo, current, hosts, opts);
        return { from: stamp?.version ?? 'unwired', to: current, hosts, global: opts.global };
    }
    catch {
        return null; // a refresh is an optimization; never fail the caller over it
    }
}
export function formatWiringRefresh(r) {
    if (!r)
        return null;
    // Name the out-of-repo writes explicitly: those are machine-wide and shared by
    // every repo, so a user seeing this line should not have to guess what moved.
    const scope = r.global && r.hosts.includes('agents') ? " (including this machine's ~/.codex config)" : '';
    return `· graft refreshed this repo's agent wiring${scope} (written by ${r.from}, now ${r.to}): ${r.hosts.join(', ')}.`;
}
//# sourceMappingURL=upkeep.js.map