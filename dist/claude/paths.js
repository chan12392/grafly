import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// This module ships inside the package at <pkgRoot>/dist/claude/paths.js. Resolving graft's
// own CLI and sibling scripts relative to THIS file — not the project dir — is what makes the
// hooks work when graft is installed as a dependency in someone else's repo (where
// <projectDir>/dist/ does not exist). In graft's own repo it resolves to ./dist all the same.
const CLAUDE_DIR = dirname(fileURLToPath(import.meta.url));
/** Absolute path to the Grafly entry shim, resolved from this module. */
export function graftCliPath() {
    return join(CLAUDE_DIR, '..', 'entry.js');
}
/** Absolute path to this package's `dist/claude` dir. Baked into the generated shims at
 * init time as their primary resolution candidate, so the statusline/hooks find graft
 * without runtime guesswork — correct regardless of how Node was installed. */
export function claudeDistDir() {
    return CLAUDE_DIR;
}
/** Where a global `npm install -g grafly` (or `npm link`) puts its `dist`, without spawning npm. */
function globalDistCandidates() {
    const bin = dirname(process.execPath);
    return [
        process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', 'grafly', 'dist'),
        join(bin, 'node_modules', 'grafly', 'dist'),
        join(bin, '..', 'lib', 'node_modules', 'grafly', 'dist'),
    ].filter(Boolean);
}
function realOrSelf(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return path;
    }
}
/** The `dist/claude` dir that user-level hook shims bake in. The globally installed Grafly's
 * when there is one, so a temporary or review checkout running the installer cannot repoint
 * every host's hooks at itself; otherwise this package's own. */
export function userHooksDistDir() {
    const own = realOrSelf(join(CLAUDE_DIR, '..'));
    const global = globalDistCandidates().find((dir) => existsSync(join(dir, 'claude', 'hooks.js')));
    return global && realOrSelf(global) !== own ? join(global, 'claude') : CLAUDE_DIR;
}
/** Absolute path to a sibling script in the claude dir (e.g. `sync-run.js`). */
export function claudeScriptPath(name) {
    return join(CLAUDE_DIR, name);
}
