/** The result of one config/shim write, reported by every installer and by MCP
 *  registration so they speak the same vocabulary. `McpWrite` aliases this. */
export interface ConfigWrite {
    id: string;
    path: string;
    action: 'created' | 'updated' | 'unchanged' | 'skipped-unparseable';
}
/**
 * Write a graft-owned file, idempotently: unchanged when the content already
 * matches (only re-applying `mode` if it drifted), else created/updated. `mode`
 * is applied on POSIX; on Windows the exec bit does not exist and is skipped by
 * the caller's expectations.
 */
export declare function writeOwned(id: string, path: string, content: string, mode?: number): ConfigWrite;
/** Whether a hooks-config entry is one graft installed (so an upgrade replaces
 *  it in place instead of stacking a second copy next to the stale one). The
 *  `?? ''` guards a stray `undefined` entry: `JSON.stringify(undefined)` is
 *  `undefined`, whose `.includes` would throw. */
export declare function isGraftEntry(entry: unknown): boolean;
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
export declare function readJsonObject(path: string): {
    root: Record<string, any>;
    existed: boolean;
} | 'unparseable';
//# sourceMappingURL=config-write.d.ts.map