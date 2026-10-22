/**
 * CLI wiring for `grafly callers` and its `--direction` / `--depth` flags.
 *
 * One command, one implementation: resolve a symbol via `resolveSymbol`, walk
 * edges via `edgeWalk` (incoming or outgoing, depth 1 or a BFS), and share the
 * same resolve-or-die flow, human formatter, and --json shape. Kept out of
 * cli.ts so that file stays thin (argument wiring only) and this logic stays
 * unit-testable without shelling out to the CLI on every case.
 *
 * `--direction out` subsumes the old `grafly callees`; `--depth N` subsumes the
 * old `grafly impact`. Exported formatters are reused by the workspace
 * federation path (`workspace.js`), so both surfaces render identical reports.
 */
import { exitCommand } from "../util/cli-exit.js";
import { resolve, join } from "node:path";
import { fileReader, referenceLine, wordRe } from "../blast/evidence.js";
import { contextDirFor } from "../context/node-file.js";
import { withSavings, savingsFor } from "../context/savings.js";
import { loadTraverseCached } from "./load.js";
import { resolveSymbol } from "./traverse.js";
import { WALK_RELATIONS } from "./relations.js";
import { judgeSymbols, cwdContextTokens } from "../circuit/judge.js";
import { appendCircuitRecord, jidFor, recordFollowup } from "../circuit/feedback.js";
import { escalateAmbiguous, escalationLines } from "../circuit/escalate.js";
const ARROW = { in: "←", out: "→" };
const DEFAULT_DEPTH = 1;
/**
 * Walk adjacency built ONCE per command instead of per match — upstream
 * edgeWalk scans all edges for every matched symbol (O(matches × edges): 44M
 * scans for 308 `close` matches on a 144k-edge graph ≈ 9s). One shared pass
 * is O(edges) and produces byte-identical hit lists: callersOf/calleesOf is
 * exactly this adjacency lookup at depth 1, and impactOfMany's BFS is the
 * same loop with frontier expansion.
 */
export function walkAdjacency(graph, direction) {
    const adj = new Map();
    for (const e of graph.edges) {
        if (!WALK_RELATIONS.has(e.relation))
            continue;
        const key = direction === "in" ? e.target : e.source;
        const other = direction === "in" ? e.source : e.target;
        const arr = adj.get(key);
        if (arr)
            arr.push({ other, relation: e.relation });
        else
            adj.set(key, [{ other, relation: e.relation }]);
    }
    return adj;
}
function symbolsInFile(graph, fileNode) {
    return graph.nodes.filter((n) => n.kind !== "file" && n.path === fileNode.path);
}
/** edgeWalk with shared adjacency — same seeds, same dedup, same hit order. */
export function sharedEdgeWalk(graph, adj, byId, node, direction, depth) {
    const seeds = depth > 1 && node.kind === "file"
        ? [node, ...symbolsInFile(graph, node)] : [node];
    const visited = new Set(seeds.map((s) => s.id));
    const hits = [];
    let frontier = [...visited];
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
        const next = [];
        for (const current of frontier) {
            for (const { other, relation } of adj.get(current) ?? []) {
                if (visited.has(other))
                    continue;
                visited.add(other);
                hits.push({ node: byId.get(other) ?? null, id: other, relation, depth: d });
                next.push(other);
            }
        }
        frontier = next;
    }
    return hits;
}
/** Exported so the workspace federation path (`workspace.js`) can render the
 * same human report format as the CLI, rather than re-implementing it — both
 * surfaces walk the same edges via the same `resolveSymbol` / `edgeWalk` core. */
export function headerOf(n) {
    return `${n.name} · ${n.kind} · ${n.path}:${n.span}`;
}
/** `showDepth` is set for multi-hop walks (depth > 1), matching the old
 * `grafly impact` output which tagged every hit with its BFS depth.
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
 * to trace these edges by hand. Shared by the CLI and the workspace path so
 * both surfaces report the same number. */
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
    return `  no indexed ${label} — the graph has no ${dir} call/reference edges for this symbol as written.${ambiguity} Check the name (try the bare symbol, or "Type.method"), or find its uses with grafly grep "${name}". Fall back to raw grep -rn only for unindexed files`;
}
/** Closest indexed names to a query that matched nothing — so a miss
 * redirects in one turn instead of sending the agent to a full-tree grep.
 * Substring matches first, then edit distance ≤2 (bounded — short-circuits
 * past the cap so it stays cheap on 100k-node graphs). */
function nearMisses(graph, query, limit = 5) {
    const q = query.toLowerCase();
    const qNorm = q.replace(/[_-]/g, ""); // snake/camel normalized
    const scored = [];
    for (const n of graph.nodes) {
        if (n.kind === "file")
            continue;
        const name = n.name.toLowerCase();
        const nameNorm = name.replace(/[_-]/g, "");
        let s = null;
        // Substring containment needs >=3 chars on the contained side —
        // otherwise every one-letter name "matches" any query.
        if ((q.length >= 3 && (name.includes(q) || nameNorm.includes(qNorm))) ||
            (name.length >= 3 && (q.includes(name) || qNorm.includes(nameNorm))))
            s = 0;
        else {
            const d = Math.min(boundedLevenshtein(q, name, 2), boundedLevenshtein(qNorm, nameNorm, 2));
            if (d <= 2)
                s = d + 1;
        }
        if (s !== null)
            scored.push([s, n]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length);
    return scored.slice(0, limit).map(([, n]) => n);
}
/** Levenshtein distance, short-circuited: returns max+1 as soon as the
 * distance provably exceeds max, so non-candidates cost O(min(len)) work. */
function boundedLevenshtein(a, b, max) {
    if (Math.abs(a.length - b.length) > max)
        return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            cur.push(v);
            if (v < rowMin)
                rowMin = v;
        }
        if (rowMin > max)
            return max + 1;
        prev = cur;
    }
    return prev[b.length];
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
/** Parse and validate the raw `--direction` string; fails the command on garbage. */
function resolveDirection(raw) {
    if (raw === undefined)
        return "in";
    if (raw === "in" || raw === "out")
        return raw;
    console.error(`✗ --direction must be "in" or "out", got "${raw}"`);
    exitCommand(1);
}
/**
 * Resolve `query` in the graph at `dir` (respecting `--dir`/`--in`), walk edges
 * per `--direction`/`--depth`, and print either the human report or `--json`.
 * Fails the command (code 1) when there's no graph or the symbol is unknown,
 * while leaving a resident CLI available for the next request.
 */
export function runCallersCommand(query, dir, opts) {
    const root = resolve(dir);
    const contextDir = contextDirFor(root, opts.globalDir);
    const graph = loadTraverseCached(contextDir);
    if (!graph) {
        console.error(`✗ no graph found at ${contextDir} — run \`grafly build\` first`);
        exitCommand(1);
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
        exitCommand(1);
        return;
    }
    if (matches.length === 0) {
        const near = nearMisses(graph, query);
        const hint = near.length
            ? `\n  near matches: ${near.map((n) => `${n.name} (${n.path})`).join(", ")}`
            : "";
        console.error(`✗ no symbol "${query}" in the graph — check spelling or run grafly build.${hint}\n` +
            `  for unindexed text (scripts, docs, generated code): grafly grep "${query}" or raw grep -rn`);
        exitCommand(1);
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
                exitCommand(1);
            }
            depth = Math.floor(d);
        }
    }
    const showDepth = depth > 1;
    // Navigation BEFORE judging: narrowing is an observation, not a correct/incorrect label.
    // Runs before this query's own judgment is appended so a query can never
    // attribute to itself.
    const logPath = circuitLogPath(contextDir);
    recordFollowup(logPath, root, query, matches.map((n) => n.id));
    // Judge and --top BEFORE walking: the circuit order decides what to show,
    // then only the shown symbols get edge-walked over one shared adjacency.
    // Upstream walked every match — O(matches × edges) — which is what made
    // ambiguous queries on large graphs slow.
    const cwdTokens = cwdContextTokens(root, process.cwd());
    const judged = judgeAndRank(graph, query, matches, { cwdTokens });
    const circuit = judged?.circuit ?? null;
    const circuitFeatures = judged?.features ?? null;
    // --top N: emit only the circuit's best N matches — the answer an agent
    // would reach after reading all of them anyway, at a fraction of the
    // output tokens. Dropped matches stay visible via the verdict line /
    // circuit.scores so nothing is hidden. Exception: never truncate past an
    // abstain — when the circuit says it cannot separate the matches, cutting
    // would hide the very ambiguity it just surfaced. Only a confident
    // ranking earns the right to cut.
    let truncated = null;
    const topN = opts.top !== undefined ? Math.max(1, Math.floor(Number(opts.top) || 1)) : null;
    const shown = topN !== null && matches.length > topN && circuit?.verdict !== "abstain"
        ? matches.slice(0, topN)
        : matches;
    if (shown.length < matches.length) {
        truncated = { shown: shown.length, total: matches.length,
            omitted: matches.slice(shown.length).map((n) => n.id) };
    }
    const adj = walkAdjacency(graph, direction);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // --limit N: cap hits shown per match (default 100; 0/all = unlimited).
    // A hub symbol (log, error, render) can have thousands of callers — an
    // agent needs the shape and a representative sample, not every line. The
    // overflow count and how-to-widen hint keep the tail discoverable.
    const hitLimit = opts.limit === undefined ? 100
        : /^(0|all|none)$/i.test(String(opts.limit)) ? Infinity
            : Math.max(1, Math.floor(Number(opts.limit) || 1));
    const results = shown.map((symbol) => {
        const hits = sharedEdgeWalk(graph, adj, byId, symbol, direction, depth);
        return { symbol, hits: hits.slice(0, hitLimit), overflow: Math.max(0, hits.length - hitLimit) };
    });
    // Call sites that named one of these symbols but were dropped for
    // ambiguity — recorded at build time (graph.ambiguousCalls) so the
    // undercount is visible instead of silent. Incoming direction only.
    const ambNames = new Set(matches.map((m) => m.name));
    const ambiguous = direction === "in"
        ? (graph.ambiguousCalls ?? []).filter((a) => ambNames.has(a.name))
        : [];
    // Opt-in second opinion: dropped call sites go to morecoffee's live
    // code_relation channel (GRAFLY_MC_HOME) — the circuit ranks from the
    // graph, MC re-reads the source. Null unless configured; never fatal.
    const escalation = escalateAmbiguous(root, query, matches, ambiguous);
    // Name-literal edge targets: an ambiguous `extends Foo` resolves to the
    // bare name, so the edge exists but is keyed under "Foo" — not under any
    // node id. For a callers query on a real same-named node that's the same
    // silent undercount, except the evidence is already in the graph: look up
    // the bare name in adjacency too. (Skipped when the name IS a matched
    // node id — file nodes are addressed by path — to avoid double-reporting
    // resolved hits.)
    const matchIds = new Set(matches.map((m) => m.id));
    const nameRefs = direction === "in"
        ? [...ambNames].filter((n) => !matchIds.has(n))
            .flatMap((n) => (adj.get(n) ?? []).map((x) => ({ source: x.other, relation: x.relation, name: n })))
        : [];
    const saved = callersSavings(graph, results);
    // Judgment log: what the circuit saw and decided, as JSONL next to the
    // graph it judged — the raw material for retraining weights and for
    // auditing bad rankings. GRAFLY_CIRCUIT_LOG=0 disables; =path redirects.
    const judgmentId = circuit
        ? logCircuit(logPath, { ts: new Date().toISOString(), type: "judge", cmd: "callers",
            query, direction, depth: !showDepth ? 1 : Number.isFinite(depth) ? depth : "all",
            in: opts.in ?? null,
            top: opts.top ?? null, root,
            matchCount: matches.length, verdict: circuit.verdict, gap: circuit.gap,
            reason: circuit.reason, top1: circuit.top,
            cwd: [...cwdTokens].join("/") || null,
            scores: circuit.scores,
            features: circuitFeatures,
            shown: shown.map((n) => n.id),
            ...(escalation ? { escalation: { resolved: escalation.resolved.length,
                sites: escalation.sites, errors: escalation.errors.length,
                elapsed_ms: escalation.elapsed_ms } } : {}) }) : null;
    if (opts.json) {
        // mc.channel.v1-style limitations: machine-readable "what this
        // answer cannot claim" list, alongside the human-visible notes.
        const limitations = [];
        const vendoredCount = circuitFeatures?.filter((f) => f.vendored === 1).length ?? 0;
        if (vendoredCount > 0)
            limitations.push(`${vendoredCount} candidate(s) live in vendored/generated paths — ranking deprioritizes them`);
        if (ambiguous.length)
            limitations.push(`${ambiguous.length} call site(s) dropped as ambiguous — incoming edges may undercount`);
        if (nameRefs.length)
            limitations.push(`${nameRefs.length} edge(s) target the bare name — attribution unknown`);
        if (truncated)
            limitations.push(`--top ${truncated.shown} of ${truncated.total} matches shown`);
        const payload = {
            schema: "grafly.callers.v1",
            query,
            matches: results.map((r) => {
                const m = { symbol: symbolJson(r.symbol), hits: r.hits.map(hitJson) };
                if (r.overflow > 0)
                    m.hitOverflow = r.overflow;
                if (r.hits.length === 0) {
                    m.note = looseNoteFor(direction, r.symbol.name, matches.length);
                }
                return m;
            }),
            saved,
        };
        if (circuit)
            payload.circuit = { ...circuit, ...(judgmentId ? { jid: judgmentId } : {}) };
        if (truncated)
            payload.truncated = truncated;
        if (ambiguous.length)
            payload.ambiguousCalls = ambiguous;
        if (nameRefs.length)
            payload.unresolvedNameRefs = nameRefs;
        if (escalation)
            payload.escalation = escalation;
        if (limitations.length)
            payload.limitations = limitations;
        console.log(JSON.stringify(payload, null, 2));
        return;
    }
    const lines = [];
    if (circuit) {
        lines.push(circuitVerdictLine(circuit, matches.length));
        if (judgmentId) lines.push(`  judgment: ${judgmentId} — label with grafly feedback (see --help)`);
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
    for (const { symbol, hits, overflow } of results) {
        lines.push(headerOf(symbol));
        if (hits.length === 0)
            lines.push(looseNoteFor(direction, symbol.name, matches.length));
        else {
            for (const h of hits)
                lines.push(hitLine(direction, h, showDepth, quoteFor(h, symbol.name, read)));
            if (overflow > 0)
                lines.push(`  … +${overflow} more ${direction === "out" ? "callees" : "callers"} (--limit 0 to show all, or --in <dir> to narrow)`);
        }
        lines.push("");
    }
    if (ambiguous.length) {
        const preview = ambiguous.slice(0, 10);
        const rest = ambiguous.length - preview.length;
        lines.push(`· ${ambiguous.length} call site(s) invoke a name in this result set but can't be attributed — ambiguous, dropped rather than guessed (not counted above):`);
        for (const a of preview)
            lines.push(`    ${a.source}`);
        if (rest > 0)
            lines.push(`    … +${rest} more`);
    }
    const escLines = escalationLines(escalation);
    if (escLines) {
        lines.push("");
        lines.push(...escLines);
    }
    if (nameRefs.length) {
        const preview = nameRefs.slice(0, 10);
        const rest = nameRefs.length - preview.length;
        lines.push(`· ${nameRefs.length} edge(s) point at the bare name — unresolved target, attribution unknown (not counted above):`);
        for (const a of preview) {
            const src = byId.get(a.source);
            lines.push(`    ${src ? `${src.name} (${src.path}:${src.span})` : a.source} ${a.relation} "${a.name}"`);
        }
        if (rest > 0)
            lines.push(`    … +${rest} more`);
    }
    const body = lines.join("\n").replace(/\n+$/, "\n");
    process.stdout.write(withSavings(body, saved));
}
/**
 * Judge same-name matches and sort `matches` best-first in place. Returns
 * {circuit, features} — circuit = the verdict block also embedded in --json
 * output, features = the per-candidate vectors the log keeps for retraining
 * (capped at the top 50: the head is where the signal lives). Shared by the
 * CLI and the workspace federation path so every surface judges identically.
 */
export function judgeAndRank(graph, query, matches, ctx) {
    if (matches.length <= 1)
        return null;
    const judged = judgeSymbols(graph, query, matches, { cwdTokens: ctx?.cwdTokens });
    const order = new Map(judged.ranked.map((r, i) => [r.node.id, i]));
    matches.sort((a, b) => order.get(a.id) - order.get(b.id));
    return {
        circuit: {
            verdict: judged.verdict,
            // mc.channel.v1 contract fields: status vocabulary, explicit
            // reason codes, and the score semantics ("a ranking score is
            // not a probability of correctness" — confidence stays null
            // because these weights are uncalibrated).
            status: judged.verdict === "abstain" ? "abstained" : "ok",
            gap: judged.gap,
            reason: judged.reason,
            reasonCodes: judged.reason ? judged.reason.split("|") : [],
            scoreType: "learned_ranking_weight",
            scoreUnit: "rank_score",
            confidence: null,
            top: judged.ranked[0].node.id,
            scores: judged.ranked.map((r) => ({ id: r.node.id, score: Number(r.score.toFixed(3)) })),
        },
        features: judged.ranked.slice(0, 50).map((r) => ({ id: r.node.id, ...r.features })),
    };
}
/** The ⚖ verdict line — one line of judgment before the match blocks, same
 * text on every surface. Abstain names its best guess explicitly: an agent that
 * reads only the header still learns which symbol the circuit preferred. */
export function circuitVerdictLine(circuit, matchCount) {
    return circuit.verdict === "abstain"
        ? `⚖ circuit: ${matchCount} same-name matches — abstain (gap ${circuit.gap.toFixed(2)}; ${reasonText(circuit.reason)}); best guess first: ${circuit.top}`
        : `⚖ circuit: ${matchCount} same-name matches — confident → ${circuit.top} (${reasonText(circuit.reason)})`;
}
/** Human-readable expansion of the machine reason code — an LLM or human
 * reading the verdict line gets WHY, not just WHAT. */
function reasonText(reason) {
    if (!reason)
        return "";
    const parts = reason.split("|");
    const out = [];
    for (const p of parts) {
        if (p === "tie")
            out.push("top-2 identical on all evidence");
        else if (p === "weak_gap")
            out.push("weak separation");
        else if (p === "equivalent_query_evidence")
            out.push("same query evidence; popularity does not identify the intended symbol");
        else if (p === "vendored_pool")
            out.push("all candidates vendored — answer is library code");
        else if (p === "lone_source")
            out.push("only project-source candidate — rest vendored/generated");
        else if (p === "unique")
            out.push("unique match");
        else if (p.startsWith("by:"))
            out.push(`separated by ${p.slice(3).replace(/\+/g, ", ")}`);
        else
            out.push(p);
    }
    return out.join("; ");
}

/** Resolved circuit-log path for this context dir, or null when logging is
 * off (GRAFLY_CIRCUIT_LOG=0/off). =path redirects — shared by the judgment
 * writer and the feedback reader so both honor the same switch. */
export function circuitLogPath(contextDir) {
    const cfg = process.env.GRAFLY_CIRCUIT_LOG;
    if (cfg === "0" || cfg === "off")
        return null;
    return cfg ? resolve(cfg) : join(contextDir, "circuit-log.jsonl");
}
/** Append one JSONL judgment record beside the graph — stamped with type and
 * a content-derived jid so later adopt/reject events can name the decision
 * they label. Best-effort: a failed write must never break a query. */
export function logCircuit(logPath, record) {
    if (!logPath)
        return null;
    record.jid = jidFor(record);
    return appendCircuitRecord(logPath, record) ? record.jid : null;
}
