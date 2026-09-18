/** Platform separators → `/`. Identity on posix. */
export declare function toPosixPath(p: string): string;
/**
 * `relative(from, to)`, normalized to posix — the canonical form of every path
 * graft stores. Use this rather than bare `relative` for anything that lands in
 * the graph, a cache key, or a manifest. Bare `relative` is still right for
 * text shown in the terminal, where a native separator is what the platform's
 * users expect.
 */
export declare function relPosix(from: string, to: string): string;
/**
 * Trailing `/` off a repo-relative path, in linear time.
 *
 * The obvious `replace(/\/+$/, "")` is a polynomial-ReDoS shape — `\/+$` can begin
 * matching at any point inside a run of slashes, so a path ending in many slashes
 * and then anything else costs O(n²). CodeQL flags it (`js/polynomial-redos`), and
 * rightly: these inputs are a `--dir` or `--in` value rather than anything
 * attacker-controlled, but the ambiguity buys nothing and a loop is both faster
 * and plainer.
 */
export declare function stripTrailingSlashes(path: string): string;
/**
 * Normalize a user-supplied path prefix (`--in`) so it can be compared against
 * a stored `node.path`: posix separators, no leading `./`, no trailing
 * separator. Windows users type — and their shell's tab-completion produces —
 * `--in server\src\gpu`, so both separators have to reduce to the same prefix.
 */
export declare function normalizePathPrefix(p: string): string;
//# sourceMappingURL=paths.d.ts.map