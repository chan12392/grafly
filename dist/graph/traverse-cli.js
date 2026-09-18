/**
 * CLI wiring for `graft callers` and its `--direction` / `--depth` flags.
 *
 * One command, one implementation: resolve a symbol via `resolveSymbol`, walk
 * edges via `edgeWalk` (incoming or outgoing, depth 1 or a BFS), and share the
 * same resolve-or-die flow, human formatter, and --json shape. Kept out of
 * cli.ts so that file stays thin (argument wiring only) and this logic stays
 * unit-testable without shelling out to the CLI on every case.
 *
 * `--direction out` subsumes the old `graft callees`; `--depth N` subsumes the
 * old `graft impact`. Exported formatters are reused by the MCP `graft_trace_calls`
 * tool (`src/mcp/tools.ts`), so both surfaces render identical reports.
 */
import { resolve } from "node:path";
import { fileReader, referenceLine, wordRe } from "../blast/evidence.js";
import { contextDirFor } from "../context/node-file.js";
import { withSavings, savingsFor } from "../context/savings.js";
import { loadGraphCached } from "./load.js";
import { resolveSymbol, edgeWalk } from "./traverse.js";
import { judgeSymbols, ABSTAIN_GAP } from "../circuit/judge.js";
const ARROW = { in: "←", out: "→" };
const DEFAULT_DEPTH = 1;
/** Exported so the MCP `graft_trace_calls` tool (`src/mcp/tools.ts`) can render the
 * same human report format as the CLI, rather than re-implementing it — both
 * surfaces walk the same edges via the same `resolveSymbol` / `edgeWalk` core. */
export function headerOf(n) {
    return `${n.name} · ${n.kind} · ${n.path}:${n.span}`;
}
/** `showDepth` is set for multi-hop walks (depth > 1), matching the old
 * `graft impact` output which tagged every hit with its BFS depth.
 *
 * `quote`, when given, is the call site itself — the line inside the hit where it
 * references the symbol. An edge that says "total calls add" is a claim; the line
 * under it is the evidence, and it saves opening the file to check.
 */
export function hitLine(direction, hit, showDepth, quote) {
    const arrow = ARROW[direction];
    const depthTag = showDepth ? ` [depth ${hit.depth}]` : "";
    const label = hit.node ? `${hit.node.name} (${hit.node.path}:${hit.node.span})` : `${hit.id} (unresolved import)`;
    const line = `  ${hit.relation} ${arrow} ${label}${depthTag}`;
    return quote ? `${line}\n      ${quote.n}: ${quote.text.trim()}` : line;
}
/**
 * The call site for one hit, or nothing.
 *
 * Only for a resolved hit whose span we can read: an unresolved import has no
 * file, and a hit at depth 2+ references something in between rather than the
 * symbol asked about, so quoting it would point at the wrong line.
 */
function quoteFor(hit, name, read) {
    if (!hit.node || hit.depth > 1)
        return undefined;
    return referenceLine(hit.node.path, hit.node.span, [wordRe(name)], read) ?? undefined;
}
/** Tokens-saved baseline for a callers/callees walk: the files of the matched
 * symbols plus every resolved edge endpoint, read whole — the files you'd open
 * to trace these edges by hand. Shared by the CLI and the MCP tool so both
 * surfaces report the same number. */
export function callersSavings(graph, results) {
    const paths = [];
    for (const { symbol, hits } of results) {
        paths.push(symbol.path);
        for (const h of hits)
            if (h.node)
                paths.push(h.node.path);
    }
    return savingsFor(graph, paths);
}
/** Loud, actionable empty-result note — never a bare empty list. `candidateCount`
 * is how many nodes {@link resolveSymbol} matched for this query (both call
 * sites already hold it as `matches.length`) — when it's >1, the query name is
 * itself ambiguous (several definitions share it), which is exactly the case
 * `resolve.ts` drops a cross-file call/reference for rather than guessing which
 * one it means. Without saying so, a zero-hit result here reads as "nothing
 * calls this" when it may really be "something does, but the edge was dropped". */
export function looseNoteFor(direction, name, candidateCount) {
    const label = direction === "out" ? "callees" : "callers";
    const dir = direction === "out" ? "outgoing" : "incoming";
    const ambiguity = candidateCount > 1
        ? ` ${candidateCount} definitions share the name "${name}"; a cross-file caller of an ambiguous name is dropped rather than guessed, so this may undercount.`
        : "";
    return `  no indexed ${label} — the graph has no ${dir} call/reference edges for this symbol as written.${ambiguity} Check the name (try the bare symbol, or "Type.method"), or find its uses with graft grep "${name}". Fall back to raw grep -rn only for unindexed files`;
}
function symbolJson(n) {
    return { id: n.id, name: n.name, kind: n.kind, path: n.path, span: n.span };
}
function hitJson(hit) {
    const out = { id: hit.id, relation: hit.relation, depth: hit.depth };
    if (hit.node) {
        out.name = hit.node.name;
        out.kind = hit.node.kind;
        out.path = hit.node.path;
        out.span = hit.node.span;
    }
    return out;
}
/** Parse and validate the raw `--direction` string; exits (code 1) on garbage. */
function resolveDirection(raw) {
    if (raw === undefined)
        return "in";
    if (raw === "in" || raw === "out")
        return raw;
    console.error(`✗ --direction must be "in" or "out", got "${raw}"`);
    process.exit(1);
}
/**
 * Resolve `query` in the graph at `dir` (respecting `--dir`/`--in`), walk edges
 * per `--direction`/`--depth`, and print either the human report or `--json`.
 * Exits the process (code 1) when there's no graph at all or the symbol is
 * unknown — both are caller-facing mistakes, not recoverable states.
 */
export function runCallersCommand(query, dir, opts) {
    const root = resolve(dir);
    const contextDir = contextDirFor(root, opts.globalDir);
    const graph = loadGraphCached(contextDir);
    if (!graph) {
        console.error(`✗ no graph found at ${contextDir} — run \`graft build\` first`);
        process.exit(1);
    }
    // `resolveSymbol` throws on an `--in` prefix that matches nothing indexed —
    // a caller mistake, reported in the same shape as the ones around it rather
    // than as a bare stack-trace message from the top-level handler.
    let matches;
    try {
        matches = resolveSymbol(graph, query, opts.in ? { in: opts.in } : {});
    }
    catch (err) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
        return;
    }
    if (matches.length === 0) {
        console.error(`✗ no symbol "${query}" in the graph — check spelling or run graft build`);
        process.exit(1);
    }
    const direction = resolveDirection(opts.direction);
    let depth = DEFAULT_DEPTH;
    if (opts.depth !== undefined) {
        // `all` (aka full/max) = the whole transitive closure: walk until no new
        // node is reached. The BFS's visited-set makes this cycle-safe, and it
        // terminates when the frontier empties. This is the "show me every
        // connected source" mode — the right first move before a multi-file
        // refactor, where stopping at direct edges misses sibling/downstream files.
        if (/^(all|full|max)$/i.test(opts.depth)) {
            depth = Number.POSITIVE_INFINITY;
        }
        else {
            const d = Number(opts.depth);
            if (!Number.isFinite(d) || d < 1) {
                console.error(`✗ --depth must be a positive number or "all", got "${opts.depth}"`);
                process.exit(1);
            }
            depth = Math.floor(d);
        }
    }
    const showDepth = depth > 1;
    const results = matches.map((symbol) => ({ symbol, hits: edgeWalk(graph, symbol, direction, depth) }));
    const saved = callersSavings(graph, results);
    // Same-name ambiguity is the judgment circuit's task: score the matches,
    // order by confidence, and state the verdict instead of silently listing
    // every same-named symbol as if they were equivalent.
    let circuit = null;
    if (matches.length > 1) {
        const judged = judgeSymbols(graph, query, matches);
        const order = new Map(judged.ranked.map((r, i) => [r.node.id, i]));
        results.sort((a, b) => order.get(a.symbol.id) - order.get(b.symbol.id));
        circuit = {
            verdict: judged.verdict,
            gap: judged.gap,
            top: judged.ranked[0].node.id,
            scores: judged.ranked.map((r) => ({ id: r.node.id, score: Number(r.score.toFixed(3)) })),
        };
    }
    // --top N: emit only the circuit's best N matches — the answer an agent
    // would reach after reading all of them anyway, at a fraction of the
    // output tokens. Dropped matches stay visible via the verdict line /
    // circuit.scores so nothing is hidden.
    let truncated = null;
    const topN = opts.top !== undefined ? Math.max(1, Math.floor(Number(opts.top) || 1)) : null;
    if (topN !== null && results.length > topN) {
        truncated = { shown: topN, total: results.length,
            omitted: results.slice(topN).map((r) => r.symbol.id) };
        results.length = topN;
    }
    if (opts.json) {
        const payload = {
            query,
            matches: results.map((r) => {
                const m = { symbol: symbolJson(r.symbol), hits: r.hits.map(hitJson) };
                if (r.hits.length === 0) {
                    m.note = looseNoteFor(direction, r.symbol.name, matches.length);
                }
                return m;
            }),
            saved,
        };
        if (circuit)
            payload.circuit = circuit;
        if (truncated)
            payload.truncated = truncated;
        console.log(JSON.stringify(payload, null, 2));
        return;
    }
    const lines = [];
    if (circuit) {
        const c = circuit;
        lines.push(c.verdict === "abstain"
            ? `⚖ circuit: ${matches.length} same-name matches — abstain (gap ${c.gap.toFixed(2)} < ${ABSTAIN_GAP}); best guess first`
            : `⚖ circuit: ${matches.length} same-name matches — confident → ${c.top}`);
        lines.push("");
    }
    if (truncated) {
        const preview = truncated.omitted.slice(0, 8);
        const rest = truncated.omitted.length - preview.length;
        lines.push(`… --top ${truncated.shown} of ${truncated.total} matches (circuit-ranked); omitted: ${preview.join(", ")}${rest > 0 ? ` … +${rest} more` : ""}`);
        lines.push("");
    }
    // One reader for the whole walk: several hits usually live in the same file.
    const read = fileReader(root);
    for (const { symbol, hits } of results) {
        lines.push(headerOf(symbol));
        if (hits.length === 0)
            lines.push(looseNoteFor(direction, symbol.name, matches.length));
        else
            for (const h of hits)
                lines.push(hitLine(direction, h, showDepth, quoteFor(h, symbol.name, read)));
        lines.push("");
    }
    const body = lines.join("\n").replace(/\n+$/, "\n");
    process.stdout.write(withSavings(body, saved));
}
//# sourceMappingURL=traverse-cli.js.map