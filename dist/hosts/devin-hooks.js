/**
 * Devin hook install: user-level, under Devin's config dir (`~/.config/devin`,
 * `%APPDATA%/devin` on Windows; GRAFLY_DEVIN_DIR overrides). Devin reads the
 * same AGENTS.md the 'agents' host writes, so init installs these hooks under
 * the same selection — and postinstall applies them directly, since the hook
 * is global and now indexes whatever folder a session opens: waiting for a
 * per-repo `grafly init` would leave Devin silent everywhere else.
 *
 * Two files are grafly-owned: the self-contained shim (it resolves the
 * installed package itself) and stdin-complete-run.cjs — Devin's transport may
 * keep stdin open after the payload, so the runner waits for one complete JSON
 * object instead of trusting EOF. Entries merge into config.json the same way
 * the Codex installer merges hooks.json: foreign hooks preserved, prior grafly
 * entries replaced in place, and a `.grafly-bak` copy kept before an existing
 * config is modified — the file carries every Devin setting, not just hooks.
 */
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { writeOwned, planOwned, mergeGraftHookEntries, readJsonObject } from './config-write.js';
function dirExists(p) {
    try {
        return statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
function devinConfigCandidates(home) {
    const dirs = [join(home, '.config', 'devin')];
    // Devin on Windows loads %APPDATA%/devin/config.json; a leftover ~/.config/devin copy is never read.
    // An explicit alternate home keeps planning/tests isolated from this account, as codexHomeDir does.
    if (process.platform === 'win32')
        dirs.unshift(join((home === homedir() && process.env.APPDATA) || join(home, 'AppData', 'Roaming'), 'devin'));
    return dirs;
}
export function devinConfigDir(home = homedir()) {
    if (process.env.GRAFLY_DEVIN_DIR)
        return dirExists(process.env.GRAFLY_DEVIN_DIR) ? process.env.GRAFLY_DEVIN_DIR : null;
    const candidates = devinConfigCandidates(home);
    for (const dir of candidates)
        if (existsSync(join(dir, 'config.json')))
            return dir;
    return candidates.find(dirExists) ?? null;
}
// An established hooks dir wins even when it isn't beside config.json — Devin
// installs have landed in both ~/.config/devin and %APPDATA%/devin.
function devinHooksDir(base, home) {
    if (process.env.GRAFLY_DEVIN_DIR)
        return join(base, 'hooks');
    const candidates = [...new Set([join(base, 'hooks'),
        ...devinConfigCandidates(home).map((d) => join(d, 'hooks'))])];
    return candidates.find((d) => existsSync(join(d, 'grafly-devin-hook.cjs')))
        ?? candidates.find(dirExists)
        ?? candidates[0];
}
const PKG_SCRIPTS = fileURLToPath(new URL('../../scripts', import.meta.url));
/** The packaged self-contained shim — Codex's session/prompt wiring installs
 *  the same file, so both hosts read one source of truth. */
export function devinShimSource() {
    return readFileSync(join(PKG_SCRIPTS, 'grafly-devin-hook.cjs'), 'utf8')
        .replace('const INSTALLED_DIST = null;', `const INSTALLED_DIST = ${JSON.stringify(join(PKG_SCRIPTS, '..', 'dist'))};`);
}
/** The files installing the Devin hook would touch — pure, no writes. Empty
 * when no Devin config dir exists, mirroring `installDevinHooks`. */
export function devinHookTargets(home = homedir()) {
    const base = devinConfigDir(home);
    if (!base)
        return [];
    const hooksDir = devinHooksDir(base, home);
    return [
        { hostId: 'agents', id: 'devin-hook-shim', path: join(hooksDir, 'grafly-devin-hook.cjs'),
            scope: 'global', kind: 'hook', what: 'Devin hook shim' },
        { hostId: 'agents', id: 'devin-hook-runner', path: join(hooksDir, 'stdin-complete-run.cjs'),
            scope: 'global', kind: 'hook', what: 'stdin completion wrapper' },
        { hostId: 'agents', id: 'devin-hooks', path: join(base, 'config.json'),
            scope: 'global', kind: 'hook', what: 'SessionStart / UserPromptSubmit / PreToolUse' },
    ];
}
export function installDevinHooks(home = homedir(), { apply = true } = {}) {
    const targets = devinHookTargets(home);
    if (targets.length === 0)
        return [];
    const [shimT, runnerT, cfgT] = targets;
    const write = apply ? writeOwned : planOwned;
    const fileWrites = [
        write(shimT.id, shimT.path, devinShimSource()),
        write(runnerT.id, runnerT.path, readFileSync(join(PKG_SCRIPTS, 'stdin-complete-run.cjs'), 'utf8')),
    ];
    const skipped = { id: 'devin-hooks', path: cfgT.path, action: 'skipped-unparseable' };
    const loaded = readJsonObject(cfgT.path);
    if (loaded === 'unparseable')
        return [...fileWrites, skipped];
    const { root, existed } = loaded;
    const before = JSON.stringify(root);
    const hooks = (root.hooks ??= {});
    if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks))
        return [...fileWrites, skipped];
    // Devin runs these through a shell on Windows — forward slashes survive
    // every quoting layer, matching the hand-installed entries.
    const q = (p) => `"${p.replaceAll('\\', '/')}"`;
    const node = q(process.execPath);
    for (const d of [
        { event: 'SessionStart', budgetMs: 9000, sub: 'session-start', timeout: 10 },
        { event: 'UserPromptSubmit', budgetMs: 14000, sub: 'prompt', timeout: 15 },
        { event: 'PreToolUse', budgetMs: 4500, sub: 'pre-tool', timeout: 5 },
    ]) {
        if (hooks[d.event] !== undefined && !Array.isArray(hooks[d.event]))
            return [...fileWrites, skipped];
        const prior = Array.isArray(hooks[d.event]) ? hooks[d.event] : [];
        const command = `${node} ${q(runnerT.path)} ${d.budgetMs} ${node} ${q(shimT.path)} ${d.sub}`;
        const entry = { hooks: [{ type: 'command', command, timeout: d.timeout }] };
        // Replace a prior grafly entry at its own slot — hook order is injection
        // order, so filter+append would silently move it behind newer hooks.
        hooks[d.event] = mergeGraftHookEntries(prior, [entry]);
    }
    if (JSON.stringify(root) === before)
        return [...fileWrites, { id: 'devin-hooks', path: cfgT.path, action: 'unchanged' }];
    if (apply) {
        if (existed)
            copyFileSync(cfgT.path, `${cfgT.path}.grafly-bak`);
        writeFileSync(cfgT.path, `${JSON.stringify(root, null, 2)}\n`);
    }
    return [...fileWrites, { id: 'devin-hooks', path: cfgT.path, action: existed ? 'updated' : 'created' }];
}
