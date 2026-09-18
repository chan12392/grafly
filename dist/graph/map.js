import { languageLabelOf } from "./extract.js";
import { WALK_RELATIONS } from "./relations.js";
import { scopeLabel, scopeOf, scopesOfGraph } from "./scopes.js";
import { withSavings, savingsFor } from "../context/savings.js";
const DEFAULT_MAX_DIRS = 16;
const DEFAULT_HUBS_PER_DIR = 3;
const DEFAULT_HOTSPOTS = 12;
/** A single group must not exceed this share of all file nodes, or it's
 * refined one path-segment deeper — see the module doc. */
const SPLIT_THRESHOLD = 0.6;
/** First `depth` path segments, joined back with `/`. Files with fewer
 * segments than `depth` (e.g. a root-level file at depth 2) just use every
 * segment they have — there's nothing deeper to split into. */
function dirKey(path, depth) {
    const segments = path.split("/");
    return segments.slice(0, Math.min(depth, segments.length)).join("/");
}
/** Incoming WALK_RELATIONS edge count per target id — the same "coupling"
 * metric `grep.ts` uses, so a hub in `graft map` means the same thing as a
 * high-inDegree group in `graft grep`. */
function computeInDegree(graph) {
    const deg = new Map();
    for (const e of graph.edges) {
        if (!WALK_RELATIONS.has(e.relation))
            continue;
        deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    }
    return deg;
}
/** Top `cap` nodes by inDegree (ties broken by name asc, then path asc, for
 * full determinism regardless of the input nodes' array order), dropping
 * anything with zero inbound edges — a hub with no callers isn't a hub. */
function topHubs(nodes, inDegree, cap) {
    return nodes
        .map((n) => ({ name: n.name, kind: n.kind, path: n.path, span: n.span, inDegree: inDegree.get(n.id) ?? 0 }))
        .filter((h) => h.inDegree > 0)
        .sort((a, b) => b.inDegree - a.inDegree || a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
        .slice(0, cap);
}
/** Display labels, not tree-sitter grammars: a `scripts/` tree of `.mjs` files is
 * "javascript" here, not "typescript". See {@link languageLabelOf}. */
function sortedLanguages(paths) {
    const set = new Set();
    for (const p of paths) {
        const label = languageLabelOf(p);
        if (label)
            set.add(label);
    }
    return [...set].sort();
}
/**
 * The directory-clustering core, factored out so it can run once over the
 * whole graph (single-scope) or once per scope's own node subset
 * (multi-scope) with identical grouping/splitting/sorting rules.
 *
 * `stripPrefix` is the scope prefix to strip before computing depth/split
 * ("" for single-scope / the root scope — a no-op, `relPath` is then the
 * identity function). Reported `DirEntry.path`s are always repo-rooted
 * (the prefix is reattached), never scope-relative — a hit stays directly
 * openable without mentally re-prefixing it.
 */
function computeDirEntries(nodes, inDegree, maxDirs, hubsPerDir, stripPrefix) {
    const fileNodes = nodes.filter((n) => n.kind === "file");
    const totalFiles = fileNodes.length;
    const relPath = (path) => stripPrefix === "" ? path : path === stripPrefix ? "" : path.slice(stripPrefix.length + 1);
    // Pass 1: depth-1 file counts (relative to `stripPrefix`), to find (at most
    // one) group over the split threshold — two groups can't both exceed 60%
    // of the same total.
    const depth1FileCounts = new Map();
    for (const n of fileNodes) {
        const key = dirKey(relPath(n.path), 1);
        depth1FileCounts.set(key, (depth1FileCounts.get(key) ?? 0) + 1);
    }
    let splitSegment = null;
    if (totalFiles > 0) {
        for (const [seg, count] of depth1FileCounts) {
            if (count / totalFiles > SPLIT_THRESHOLD) {
                splitSegment = seg;
                break;
            }
        }
    }
    const depthFor = (rp) => (splitSegment !== null && dirKey(rp, 1) === splitSegment ? 2 : 1);
    // Pass 2: assign every node (file and symbol alike) to its group.
    const groups = new Map();
    for (const n of nodes) {
        const rp = relPath(n.path);
        const key = dirKey(rp, depthFor(rp));
        let g = groups.get(key);
        if (!g) {
            g = { files: [], symbols: [] };
            groups.set(key, g);
        }
        if (n.kind === "file")
            g.files.push(n);
        else
            g.symbols.push(n);
    }
    const fullPath = (relKey) => stripPrefix === "" ? relKey : relKey === "" ? stripPrefix : `${stripPrefix}/${relKey}`;
    // A group's key is a FILE's own path (not a directory) exactly when the
    // split-refinement's depth-2 grouping had nowhere deeper to go and
    // `dirKey` degenerated to the file's full relative path verbatim — see
    // `dirKey`'s doc. Detecting that by membership (rather than re-deriving
    // depth here) stays correct regardless of which pass produced the key.
    const fileRelPaths = new Set(fileNodes.map((f) => relPath(f.path)));
    const dirEntries = [...groups.entries()].map(([relKey, g]) => ({
        path: fullPath(relKey),
        files: g.files.length,
        symbols: g.symbols.length,
        languages: sortedLanguages(g.files.map((f) => f.path)),
        hubs: topHubs(g.symbols, inDegree, hubsPerDir),
        isFile: fileRelPaths.has(relKey),
    }));
    dirEntries.sort((a, b) => b.symbols - a.symbols || a.path.localeCompare(b.path));
    const dropped = Math.max(0, dirEntries.length - maxDirs);
    const dirs = dirEntries.slice(0, maxDirs);
    return { dirs, dropped };
}
/**
 * Build the repo map from an already-loaded `GraphV1`. Deterministic: same
 * graph in → byte-identical `RepoMap` out (modulo insertion order, which is
 * never observed — everything meaningful is sorted).
 *
 * Single-scope repos (`scopesOfGraph(graph).length <= 1`, the overwhelming
 * majority) take the exact pre-scope-awareness path below — same branch guard
 * `ask.ts` uses, so this is a byte-level regression guarantee. Multi-scope
 * repos group `dirs` by scope FIRST (see `scopes` on `RepoMap`); `dirs` itself
 * is then empty and `scopes` carries the breakdown instead.
 */
export function buildRepoMap(graph, opts = {}) {
    const maxDirs = opts.maxDirs ?? DEFAULT_MAX_DIRS;
    const hubsPerDir = opts.hubsPerDir ?? DEFAULT_HUBS_PER_DIR;
    const hotspotsN = opts.hotspots ?? DEFAULT_HOTSPOTS;
    const fileNodes = graph.nodes.filter((n) => n.kind === "file");
    const totalFiles = fileNodes.length;
    const inDegree = computeInDegree(graph);
    const scopes = scopesOfGraph(graph);
    let dirs;
    let dropped;
    let scopeGroups;
    if (scopes.length <= 1) {
        const computed = computeDirEntries(graph.nodes, inDegree, maxDirs, hubsPerDir, "");
        dirs = computed.dirs;
        dropped = computed.dropped;
    }
    else {
        // Multi-scope: each scope gets its OWN dir breakdown, computed exactly
        // like the single-scope path above but fed only that scope's node
        // subset (prefix stripped for depth/split math, reattached on output).
        // Grouping by raw first-path-segment instead would pool every scope
        // nested more than one segment deep (e.g. two workspace packages both
        // under `packages/`) into one shared bucket, losing the split entirely.
        dirs = [];
        dropped = 0;
        scopeGroups = scopes.map((s) => {
            const nodesInScope = graph.nodes.filter((n) => scopeOf(n.path, scopes).prefix === s.prefix);
            const computed = computeDirEntries(nodesInScope, inDegree, maxDirs, hubsPerDir, s.prefix);
            return { scope: scopeLabel(s.prefix), dirs: computed.dirs, dropped: computed.dropped };
        });
    }
    const allSymbols = graph.nodes.filter((n) => n.kind !== "file");
    const hotspots = topHubs(allSymbols, inDegree, hotspotsN);
    return {
        totals: {
            files: totalFiles,
            symbols: allSymbols.length,
            edges: graph.edges.length,
            languages: sortedLanguages(fileNodes.map((f) => f.path)),
        },
        dirs,
        scopes: scopeGroups,
        hotspots,
        dropped,
        saved: savingsFor(graph, fileNodes.map((f) => f.path)),
    };
}
const DIR_COL_WIDTH = 20;
function basenameOf(path) {
    const i = path.lastIndexOf("/");
    return i >= 0 ? path.slice(i + 1) : path;
}
function formatDirHub(h) {
    return `${h.name} (${basenameOf(h.path)}, ${h.inDegree}←)`;
}
function formatDirLine(d) {
    // `d.path` is only ever a real directory unless the >60% split refinement
    // bottomed out on a file with nowhere deeper to split into (`d.isFile`) —
    // only then is the trailing "/" wrong (it would glue onto the file's own
    // extension, e.g. "auth.ts/").
    const label = (d.isFile ? d.path : `${d.path}/`).padEnd(DIR_COL_WIDTH);
    const counts = `${d.files} files · ${d.symbols} symbols`;
    const hubs = d.hubs.length ? `   hubs: ${d.hubs.map(formatDirHub).join(", ")}` : "";
    return `${label}${counts}${hubs}`;
}
function formatHotspot(h) {
    return `${h.name} · ${h.kind} · ${h.path}:${h.span} · ${h.inDegree}←`;
}
/** The "+N more directories not shown" note, or null when nothing was dropped. */
function droppedNote(dropped) {
    if (dropped <= 0)
        return null;
    return `… +${dropped} more director${dropped === 1 ? "y" : "ies"} not shown (raise max-dirs to see more)`;
}
/**
 * Render a `RepoMap` as the human report. Deterministic (same map in → same
 * string out) and targets <= 6000 chars for a typical repo (the `maxDirs`/
 * `hubsPerDir`/`hotspots` caps in `buildRepoMap` are what keep it bounded on
 * very large graphs).
 */
export function formatRepoMap(map) {
    const { totals } = map;
    const header = `repo map — ${totals.files} files · ${totals.symbols} symbols · ${totals.edges} edges · ${totals.languages.join(", ")}`;
    const lines = [header, ""];
    if (map.scopes) {
        // Multi-scope: scope label as the top-level group heading, that scope's
        // own dirs listed under it — `map.dirs` is empty here, see `buildRepoMap`.
        for (const sg of map.scopes) {
            lines.push(`## ${sg.scope}`);
            for (const d of sg.dirs)
                lines.push(formatDirLine(d));
            const note = droppedNote(sg.dropped);
            if (note)
                lines.push(note);
            lines.push("");
        }
    }
    else {
        for (const d of map.dirs)
            lines.push(formatDirLine(d));
        const note = droppedNote(map.dropped);
        if (note)
            lines.push(note);
        lines.push("");
    }
    lines.push(`hotspots: ${map.hotspots.map(formatHotspot).join("  ")}`);
    const body = lines.join("\n");
    return withSavings(body, map.saved) + "\n";
}
//# sourceMappingURL=map.js.map