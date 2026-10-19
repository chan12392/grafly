/**
 * Active-layer install for CLI agents that read user-level hooks.json.
 * SessionStart/UserPromptSubmit run the self-contained devin-hook shim —
 * it auto-indexes whatever folder the session opens (git root or not) and
 * gates prompt retrieval. PostToolUse/Stop keep the generated shim: the
 * devin shim's injected-context envelope only exists for those two events.
 */
import { writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { hooksShim } from '../claude/shim-template.js';
import { claudeDistDir } from '../claude/paths.js';
import { writeOwned, planOwned, mergeGraftHookEntries, readJsonObject } from './config-write.js';
import { devinShimSource } from './devin-hooks.js';
function dirExists(p) {
    try {
        return statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
/** Use the active Codex account, or the conventional home when unset. */
export function codexHomeDir(home = homedir()) {
    // An explicit alternate home keeps planning/tests isolated from this account.
    return resolve((home === homedir() && process.env.CODEX_HOME) || join(home, '.codex'));
}
/** Files the installer would touch, without writing. Hooks apply to every repo
 *  opened in this Codex account. Empty when its config directory is absent. */
export function hookTargets(home = homedir()) {
    const base = codexHomeDir(home);
    if (!dirExists(base))
        return [];
    const loaded = readJsonObject(join(base, 'hooks.json'));
    const commands = Object.values(loaded?.root?.hooks ?? {})
        .flatMap((entries) => Array.isArray(entries) ? entries : [])
        .flatMap((entry) => Array.isArray(entry?.hooks) ? entry.hooks : [])
        .map((handler) => handler?.command);
    const shimPath = (file, subs) => {
        const shared = join(home, '.codex', 'hooks', 'grafly', file);
        // Keep registered shared shim paths stable because Codex hashes command definitions.
        if (base !== resolve(home, '.codex')
            && subs.some((sub) => commands.includes(`node "${shared}" ${sub}`))
            && statSync(shared, { throwIfNoEntry: false })?.isFile())
            return shared;
        return join(base, 'hooks', 'grafly', file);
    };
    return [
        {
            hostId: 'agents', id: 'codex-hook-shim',
            path: shimPath('grafly-hooks.cjs', ['post-edit', 'stop']),
            scope: 'global', kind: 'hook', what: 'post-edit/stop hook shim',
        },
        {
            hostId: 'agents', id: 'codex-agent-shim',
            path: shimPath('grafly-devin-hook.cjs', ['session-start', 'prompt']),
            scope: 'global', kind: 'hook', what: 'session-start/prompt hook shim',
        },
        {
            hostId: 'agents', id: 'codex-hooks',
            path: join(base, 'hooks.json'),
            scope: 'global', kind: 'hook', what: 'SessionStart / UserPromptSubmit / PostToolUse / Stop',
        },
    ];
}
function desiredEntries(shims) {
    // Codex hook timeouts are expressed in seconds.
    return [
        { event: 'SessionStart', matcher: 'startup|resume|compact', sub: 'session-start', timeout: 10, shim: shims.agent },
        { event: 'UserPromptSubmit', sub: 'prompt', timeout: 15, shim: shims.agent },
        { event: 'PostToolUse', matcher: 'apply_patch|Write|Edit|MultiEdit', sub: 'post-edit', timeout: 10, shim: shims.gen },
        { event: 'Stop', sub: 'stop', timeout: 10, shim: shims.gen },
    ];
}
export function installCodexHooks(home, { apply = true } = {}) {
    const targets = hookTargets(home);
    if (targets.length === 0)
        return [];
    const [shimT, agentT, cfgT] = targets;
    const fileWrites = [
        (apply ? writeOwned : planOwned)(shimT.id, shimT.path, hooksShim(claudeDistDir()), 0o755),
        (apply ? writeOwned : planOwned)(agentT.id, agentT.path, devinShimSource(), 0o755),
    ];
    const cfgPath = cfgT.path;
    const skipped = { id: 'codex-hooks', path: cfgPath, action: 'skipped-unparseable' };
    const loaded = readJsonObject(cfgPath);
    if (loaded === 'unparseable')
        return [...fileWrites, skipped];
    const { root, existed } = loaded;
    const before = JSON.stringify(root);
    const hooks = (root.hooks ??= {});
    if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks))
        return [...fileWrites, skipped];
    for (const d of desiredEntries({ gen: shimT.path, agent: agentT.path })) {
        if (hooks[d.event] !== undefined && !Array.isArray(hooks[d.event]))
            return [...fileWrites, skipped];
        const prior = Array.isArray(hooks[d.event]) ? hooks[d.event] : [];
        const handler = { type: 'command', command: `node "${d.shim}" ${d.sub}`, timeout: d.timeout };
        const entry = d.matcher ? { matcher: d.matcher, hooks: [handler] } : { hooks: [handler] };
        // Preserve foreign entries in this event; replace any prior graft entry so an
        // upgrade re-points to the current shim/sub-command instead of stacking.
        hooks[d.event] = mergeGraftHookEntries(prior, [entry]);
    }
    if (JSON.stringify(root) === before)
        return [...fileWrites, { id: 'codex-hooks', path: cfgPath, action: 'unchanged' }];
    if (apply)
        writeFileSync(cfgPath, `${JSON.stringify(root, null, 2)}\n`);
    return [...fileWrites, { id: 'codex-hooks', path: cfgPath, action: existed ? 'updated' : 'created' }];
}
