/** A source file a node was derived from, with its content hash at generation time. */
export interface SourceRef {
    path: string;
    hash: string;
}
/** A directed edge to another node (by slug). */
export interface NodeLink {
    to: string;
    relation: string;
    description?: string;
}
/** A single node in the graph — one markdown file. */
export interface ContextNode {
    name: string;
    slug: string;
    /** Coarse category from extraction: system | service | api | concept | … */
    type: string;
    /** Prose description that becomes the node body. */
    summary: string;
    /** Source files that produced this node (empty only for hand-authored nodes). */
    sources: SourceRef[];
    /** sha256 over the sorted `path:hash` lines of {@link sources}. */
    sourcesDigest: string;
    /** Outbound edges. */
    links: NodeLink[];
    /** Free-form region below the generated block, preserved across re-runs. */
    human: string;
}
/** The generated index written alongside the node files. */
export interface Manifest {
    version: number;
    /** Human label for the model that built the graph, e.g. "openrouter:openai/gpt-4o-mini". */
    model: string;
    /** sha256 over every source file's `path:hash` — the whole-graph fingerprint. */
    repoDigest: string;
    /** Every source file `init` processed, with its hash. The staleness ground-truth. */
    files: SourceRef[];
    /** Node roster (a subset of each node's frontmatter, for fast reads). */
    nodes: Array<{
        slug: string;
        name: string;
        type: string;
        sources: string[];
        sourcesDigest: string;
    }>;
}
export declare const MANIFEST_VERSION = 1;
/** Gitignored cache dir (per-file summaries + extractions), never committed. */
export declare const CACHE_DIR = ".cache";
/** Turn a display name into a stable, filesystem- and link-safe slug. */
export declare function slugify(name: string): string;
/** sha256 over the sorted `path:hash` lines of a set of sources. */
export declare function digestSources(sources: SourceRef[]): string;
/** Absolute path of the `graft/` directory for a repo root. Visible (not
 * dot-prefixed) on purpose: default ripgrep skips hidden dirs, so the agent's
 * grep/ls/find reflex must be able to land on the graph. */
export declare function contextDirFor(root: string, override?: string): string;
/**
 * Make sure the repo's root `.gitignore` ignores the graft output dir. The
 * graph is a local, regenerable cache (like `node_modules`), not a committed
 * artifact, so every `graft build` adds the entry itself the first time — the
 * user never has to think about it. No-ops when the entry is already present
 * or the dir lives outside `root` (a custom `--dir` elsewhere, which can't be
 * expressed as a repo-relative ignore). Best-effort: an unwritable `.gitignore`
 * must never abort a build, so write failures are swallowed.
 */
export declare function ensureGitignored(root: string, contextDir: string): void;
/**
 * Keep the card tree greppable even though it's gitignored, by writing a root
 * `.ignore` that re-admits it.
 *
 * The cards exist so that a `grep <symbol>` lands on a ~150-token card instead of
 * a whole source file. Making the graph a local cache (and so gitignored) silently
 * broke that: **ripgrep honours `.gitignore`**, and every ripgrep-backed search
 * tool inherits the blind spot — verified by a card that names a symbol which
 * default `rg` will not return and `rg -uu` finds instantly. `.ignore` is read at
 * higher precedence than `.gitignore`, so re-admitting the tree there restores
 * search without git ever tracking a byte of it.
 *
 * The two negative entries matter as much as the positive one: `.cache/` holds a
 * multi-MB parse memo and `.graph/` holds `wiring.json`, and dropping either into
 * every repo-wide search would be worse than the problem being fixed.
 *
 * Same contract as {@link ensureGitignored}: idempotent, skips a context dir
 * outside `root`, and swallows write failures — a build that already succeeded
 * must not fail over a convenience file.
 */
export declare function ensureSearchable(root: string, contextDir: string): void;
/** Serialize a node to its full markdown file contents. */
export declare function renderNodeFile(node: ContextNode): string;
/**
 * Write a node file, preserving any existing human region. Returns the file
 * path written.
 */
export declare function writeNode(dir: string, node: ContextNode): string;
/** A node file parsed back off disk (frontmatter only; body is not needed for `check`). */
export interface ParsedNode {
    slug: string;
    name: string;
    type: string;
    sources: SourceRef[];
    sourcesDigest: string;
    links: NodeLink[];
}
/** Read and parse every concept-node `.md` in a context dir (skips INDEX.md
 * and root-level per-file cards). */
export declare function readNodes(dir: string): ParsedNode[];
/** List the node files present (slug → filename), for pruning deleted nodes. */
export declare function existingNodeSlugs(dir: string): Set<string>;
/** Delete a node file by slug. */
export declare function deleteNode(dir: string, slug: string): void;
export declare function writeManifest(dir: string, manifest: Manifest): void;
export declare function readManifest(dir: string): Manifest | undefined;
//# sourceMappingURL=node-file.d.ts.map