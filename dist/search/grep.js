/**
 * `graft grep` core: regex search over the graph's indexed files, with hits
 * grouped by their innermost enclosing symbol and ranked by incoming-edge
 * count (coupling) — a grep that answers "which of these hits matters",
 * because plain `grep -rn` gives no way to tell a hit inside a
 * heavily-depended-on function from one inside dead code.
 *
 * Pure I/O + regex, no CLI/MCP concerns: `grep-cli.ts` formats this into
 * human text and wires the CLI command; `mcp/tools.ts` renders the same
 * shape for the `graft_find_all` tool.
 */
import { join } from "node:path";
import { WALK_RELATIONS } from "../graph/relations.js";
import { assertPrefixIndexed, pathUnderPrefix } from "../graph/scopes.js";
import { normalizePathPrefix } from "../util/paths.js";
import { savingsFor } from "../context/savings.js";
import { readSourceFile } from "../util/source.js";
const DEFAULT_MAX_HITS = 300;
const MAX_HIT_TEXT = 160;
const SPAN_RE = /^L(\d+)-L(\d+)$/;
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function spanBounds(span) {
    const m = SPAN_RE.exec(span);
    if (!m)
        return null;
    return { start: Number(m[1]), end: Number(m[2]) };
}
/** The file's symbol nodes, sorted ascending by span start — the order
 * `enclosingSymbol` scans in to find the innermost containing span. */
function symbolsOf(graph, path) {
    const out = [];
    for (const n of graph.nodes) {
        if (n.kind === "file" || n.path !== path)
            continue;
        const b = spanBounds(n.span);
        if (b)
            out.push({ node: n, start: b.start, end: b.end });
    }
    out.sort((a, b) => a.start - b.start);
    return out;
}
/** Innermost symbol containing `line`: among spans that contain it, the one
 * with the greatest start line. Symbols are pre-sorted ascending by start,
 * so the last containing match seen wins, and the scan can stop as soon as
 * a span starts after `line` — nothing later in the sort can contain it. */
function enclosingSymbol(symbols, line) {
    let found = null;
    for (const s of symbols) {
        if (s.start > line)
            break;
        if (line <= s.end)
            found = s.node;
    }
    return found;
}
/** Incoming WALK_RELATIONS edge count per target id — one pass over
 * `graph.edges`, computed once per call and shared across every hit. */
function computeInDegree(graph) {
    const deg = new Map();
    for (const e of graph.edges) {
        if (!WALK_RELATIONS.has(e.relation))
            continue;
        deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    }
    return deg;
}
function toSymbolRef(n) {
    const hash = n.id.indexOf("#");
    return { id: n.id, name: hash >= 0 ? n.id.slice(hash + 1) : n.name, kind: n.kind, path: n.path, span: n.span };
}
export function grepGraph(graph, repoRoot, pattern, opts = {}) {
    const maxHits = opts.maxHits ?? DEFAULT_MAX_HITS;
    const source = opts.fixed ? escapeRegExp(pattern) : pattern;
    const regex = new RegExp(source, opts.ignoreCase ? "i" : "");
    const inDegree = computeInDegree(graph);
    // Same segment-aware prefix rule as `ask --in` / `callers --in`, and the same
    // loud failure when it matches nothing — `--in` used to mean a bare substring
    // here and a path prefix there, so `--in src` also swept up `lib/mysrc/`.
    const inPrefix = opts.in ? normalizePathPrefix(opts.in) : undefined;
    if (inPrefix)
        assertPrefixIndexed(graph, inPrefix);
    const fileNodes = graph.nodes.filter((n) => n.kind === "file" && (inPrefix === undefined || pathUnderPrefix(n.path, inPrefix)));
    const groups = new Map();
    let collected = 0;
    let truncatedHits = 0;
    let truncatedFiles = 0;
    for (const file of fileNodes) {
        let text;
        try {
            const decoded = readSourceFile(join(repoRoot, file.path));
            if (decoded === null) {
                truncatedFiles++; // unsupported encoding (e.g. UTF-16BE) — same posture as unreadable
                continue;
            }
            text = decoded;
        }
        catch {
            truncatedFiles++;
            continue;
        }
        const symbols = symbolsOf(graph, file.path);
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            if (!regex.test(raw))
                continue;
            if (collected >= maxHits) {
                truncatedHits++;
                continue;
            }
            collected++;
            const lineNo = i + 1;
            const sym = enclosingSymbol(symbols, lineNo);
            const key = sym ? sym.id : `file:${file.path}`;
            let group = groups.get(key);
            if (!group) {
                group = {
                    symbol: sym ? toSymbolRef(sym) : null,
                    path: file.path,
                    inDegree: sym ? (inDegree.get(sym.id) ?? 0) : 0,
                    hits: [],
                };
                groups.set(key, group);
            }
            const trimmed = raw.trim();
            group.hits.push({ line: lineNo, text: trimmed.length > MAX_HIT_TEXT ? trimmed.slice(0, MAX_HIT_TEXT) : trimmed });
        }
    }
    const sortedGroups = [...groups.values()].sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path));
    return {
        pattern,
        filesSearched: fileNodes.length,
        totalHits: collected,
        groups: sortedGroups,
        truncated: { files: truncatedFiles, hits: truncatedHits },
        saved: savingsFor(graph, sortedGroups.map((g) => g.path)),
    };
}
//# sourceMappingURL=grep.js.map