import { type Drift } from "./fingerprint.js";
export interface RefreshResult {
    /** True when the graph on disk was rebuilt by this call. */
    refreshed: boolean;
    /** What the probe found, when it ran and found something. */
    drift?: Drift;
    /** One-line explanation for the agent/user, when there's something worth saying. */
    note?: string;
}
export interface RefreshOptions {
    contextDir?: string;
    /** Skip everything (the `--no-refresh` flag). */
    disabled?: boolean;
}
/**
 * Release the lock if this process is asked to die while holding it. Returns the
 * un-hook.
 *
 * Not hypothetical: the Claude Code prompt hook runs `graft ask` with a timeout, and
 * `execFileSync` enforces it with SIGTERM. Node's default disposition for SIGTERM is
 * to exit without unwinding, so the `finally` below never runs and the lock outlives
 * the process — after which the background sync is blocked and every query waits and
 * then answers stale until the lock ages out. Ctrl-C on a CLI query is the same story
 * with SIGINT.
 *
 * Adding a listener replaces that default disposition, so re-raise it explicitly
 * afterwards: remove ourselves, then `process.kill(process.pid, sig)`, so the exit
 * status still says "terminated by signal" for whoever is waiting on us.
 */
export declare function releaseOnSignal(cache: string): () => void;
/**
 * Rebuild `root`'s structural graph if the working tree has moved since the last
 * build. Cheap and side-effect-free when nothing changed, which is the usual case.
 *
 * `root` is the repository root (the same value the query itself is given), not
 * the context dir.
 */
export declare function ensureFreshGraph(root: string, opts?: RefreshOptions): Promise<RefreshResult>;
/**
 * Workspace variant: refresh each child repo's own graph (a workspace parent holds
 * an index, never nodes). Children are independent, but they're refreshed in
 * sequence — a fan-out of concurrent tree-sitter builds would spike CPU on the
 * very path that's supposed to feel free.
 */
export declare function ensureFreshChildren(root: string, children: string[], opts?: RefreshOptions): Promise<RefreshResult>;
/** The one-line note a CLI/MCP surface prints when a refresh actually happened.
 * Null when there's nothing to say (the overwhelmingly common case). */
export declare function refreshNote(r: RefreshResult): string | null;
//# sourceMappingURL=refresh.d.ts.map