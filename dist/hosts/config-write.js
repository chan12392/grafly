/**
 * Shared helpers for the host config writers. The hook installers (Codex,
 * user-level under `CODEX_HOME` or `~/.codex`; Cursor, repo-local under `.cursor`; Devin,
 * user-level under its config dir) merge graft entries into a JSON config, own
 * a generated shim, and
 * describe the outcome with the same little result record. The file-owning write,
 * the graft-entry test, and the load-or-skip JSON open are identical across them;
 * event shapes differ per host, while owned-handler replacement is shared.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
/**
 * Write a graft-owned file, idempotently: unchanged when the content already
 * matches (only re-applying `mode` if it drifted), else created/updated. `mode`
 * is applied on POSIX; on Windows the exec bit does not exist and is skipped by
 * the caller's expectations.
 */
export function writeOwned(id, path, content, mode) {
    const existed = existsSync(path);
    if (existed && readFileSync(path, 'utf8') === content) {
        if (mode !== undefined && (statSync(path).mode & 0o777) !== mode)
            chmodSync(path, mode);
        return { id, path, action: 'unchanged' };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (mode !== undefined)
        chmodSync(path, mode);
    return { id, path, action: existed ? 'updated' : 'created' };
}
/** `writeOwned`'s read-only twin: the same action the write would report,
 *  without touching the file — used by `--dry-run` reconciliation. Mode is
 *  accepted for the shared call shape but ignored, matching `writeOwned`,
 *  which chmods silently and still reports 'unchanged' on mode-only drift. */
export function planOwned(id, path, content, mode) {
    if (!existsSync(path))
        return { id, path, action: 'created' };
    return { id, path, action: readFileSync(path, 'utf8') === content ? 'unchanged' : 'updated' };
}
/** Whether an entry contains a Grafly shim command. Descriptions and other
 *  metadata do not establish ownership; mixed groups are handled below.
 *  The devin-hook shim serves both Devin and Codex session/prompt events. */
export function isGraftEntry(entry) {
    if (Array.isArray(entry?.hooks)) return entry.hooks.some(isGraftEntry);
    return typeof entry?.command === 'string'
        && /(?:^|[\\/\s"'])(?:grafly|graft)-(?:devin-hook|hooks)\.cjs(?=$|[\s"'])/.test(entry.command);
}
/** Replace only Grafly handlers, preserving foreign handlers, their metadata
 *  and execution order. An empty replacement retracts the same owned commands. */
export function mergeGraftHookEntries(prior, replacement = []) {
    const out = [];
    let inserted = false;
    const insert = () => {
        if (!inserted) out.push(...replacement);
        inserted = true;
    };
    for (const entry of prior) {
        if (!isGraftEntry(entry)) { out.push(entry); continue; }
        if (!Array.isArray(entry.hooks)) { insert(); continue; }
        let kept = [];
        for (const hook of entry.hooks) {
            if (!isGraftEntry(hook)) { kept.push(hook); continue; }
            if (!inserted) {
                if (kept.length) out.push({ ...entry, hooks: kept });
                kept = [];
                insert();
            }
        }
        if (kept.length) out.push({ ...entry, hooks: kept });
    }
    if (!inserted) out.push(...replacement);
    return out;
}
/**
 * Load a JSON config that graft is about to merge into, distinguishing the three
 * outcomes an installer must treat differently:
 *   - missing → `{ root: {}, existed: false }`: start fresh, this is a create.
 *   - a plain object → `{ root, existed: true }`: merge into it.
 *   - anything else (parse error, or a top-level array/null/primitive) →
 *     `'unparseable'`: leave the file exactly as the user left it.
 *
 * Deliberately NOT `readJson` from `util/state.ts`, which returns `null` for both
 * missing and unparseable — collapsing those two would let a create silently
 * clobber a hand-edited broken `hooks.json`.
 */
export function readJsonObject(path) {
    if (!existsSync(path))
        return { root: {}, existed: false };
    let root;
    try {
        root = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return 'unparseable';
    }
    if (typeof root !== 'object' || root === null || Array.isArray(root))
        return 'unparseable';
    return { root: root, existed: true };
}
