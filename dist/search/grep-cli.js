/**
 * CLI wiring + human formatter for `graft grep`.
 *
 * Kept out of cli.ts (argument wiring only) and out of grep.ts (pure core,
 * unit-testable against hand-built fixture graphs without touching a real
 * repo root) — same split as traverse.ts/traverse-cli.ts. `formatGrepResult`
 * is exported so the workspace surface renders the identical
 * report, rather than re-implementing it.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { withSavings } from "../context/savings.js";
import { loadTraverseCached } from "../graph/load.js";
import { pathUnderPrefix } from "../graph/scopes.js";
import { wiringPath } from "../graph/write.js";
import { normalizePathPrefix } from "../util/paths.js";
import { checkDeadend, loadDeadends, recordMiss, saveDeadends, statScope } from "./deadends.js";
import { grepGraph } from "./grep.js";
function groupHeader(g) {
    if (g.symbol)
        return `${g.symbol.name} · ${g.symbol.kind} · ${g.symbol.path}:${g.symbol.span} · ${g.inDegree} in-edges`;
    return `${g.path} (module level) · ${g.inDegree} in-edges`;
}
function formatGroup(g) {
    const lines = [groupHeader(g)];
    for (const h of g.hits)
        lines.push(`  L${h.line}: ${h.text}`);
    return lines.join("\n");
}
/** `"<pattern>" — N hits in M symbols across K files (searched T indexed files)` */
export function formatGrepHeader(result) {
    const filesHit = new Set(result.groups.map((g) => g.path)).size;
    return `"${result.pattern}" — ${result.totalHits} hits in ${result.groups.length} symbols across ${filesHit} files (searched ${result.filesSearched} indexed files)`;
}
/** Loud truncation note — dropped counts are never silent. */
function truncationNote(result) {
    const { files, hits } = result.truncated;
    if (files === 0 && hits === 0)
        return null;
    const parts = [];
    if (hits > 0)
        parts.push(`${hits} more hit${hits === 1 ? "" : "s"} beyond the cap`);
    if (files > 0)
        parts.push(`${files} indexed file${files === 1 ? "" : "s"} unreadable`);
    return `(truncated: ${parts.join(", ")} — narrow with --in or refine the pattern)`;
}
/** Full human report: header, blank line, then one block per group (header +
 * indented hit lines), each block separated by a blank line. */
export function formatGrepResult(result) {
    // The truncation note rides directly under the header, not at the bottom:
    // "never silent" has to survive a `head -N` too (same reason the savings
    // line is a header — see withSavings).
    const note = truncationNote(result);
    const head = note ? `${formatGrepHeader(result)}\n${note}` : formatGrepHeader(result);
    const blocks = [head, "", ...result.groups.map((g) => formatGroup(g) + "\n")];
    const out = blocks.join("\n").replace(/\n+$/, "\n");
    return withSavings(out, result.saved);
}
/** Loud, actionable zero-hit note (never a bare empty result) — printed to
 * stderr; the caller still exits 0, since "no hits in the indexed graph" is
 * not an error, just a reason to fall back to a real grep.
 *
 * Truncation is never silent, even on the zero-hit path: if some indexed
 * files couldn't be read (`truncated.files > 0`), that's called out too —
 * otherwise a zero-hit result on a stale graph or wrong root reads as "no
 * matches" when really some files were never searched at all. */
export function zeroHitNote(result) {
    const base = `no hits for "${result.pattern}" in ${result.filesSearched} indexed files. The pattern may be too specific — retry grafly grep with a bare symbol name or short substring (drop the receiver, full signature, and regex anchors). All indexed code was searched; use raw grep -rn only for genuinely unindexed files (docs, configs, brand-new files)`;
    const { files } = result.truncated;
    if (files === 0)
        return base;
    return `${base} — note: ${files} indexed file${files === 1 ? "" : "s"} could not be read (stale graph? run grafly build)`;
}
/**
 * The journal's scope key: the `--in` prefix plus the match mode, JSON-encoded
 * so no separator choice can collide with a path character. Match mode
 * belongs in the key because a miss proves only what that exact search tried
 * — a case-sensitive miss for `Foo` must not answer a later `--ignore-case
 * foo`, which could legitimately hit on `foo`/`FOO`.
 */
function deadendScope(opts) {
    const inPrefix = opts.in ? normalizePathPrefix(opts.in) : "";
    return JSON.stringify([inPrefix, opts.fixed ? "f" : "r", opts.ignoreCase ? "i" : ""]);
}
/** Predicate narrowing the scope stamp to the `--in` prefix — the same
 * segment-aware rule `grepGraph` applies to file nodes, so the stamp covers
 * exactly the files the search would read. */
function deadendIgnore(inArg) {
    const prefix = inArg ? normalizePathPrefix(inArg) : "";
    return prefix === "" ? undefined : (rel) => !pathUnderPrefix(rel, prefix);
}
/**
 * Resolve the graph at `dir` (respecting `--dir`), run `grepGraph`, and print
 * either the human report or `--json`. Exits the process (code 1) when
 * there's no graph at all or the pattern fails to compile as a regex — both
 * are caller-facing mistakes, not recoverable states. Zero hits is NOT an
 * error: it prints a loud note to stderr and exits 0.
 *
 * Dead-end journal: a verified-empty search is recorded in
 * `<contextDir>/.cache/deadends.json` together with a stamp of the searched
 * scope. A repeat of the same query on an unchanged scope is answered from
 * the journal — before the graph is even parsed — with the same zero-hit
 * note plus a `dead-end hit` marker. Journaling is fail-open throughout and
 * skipped under `--json`, whose machine readers get the full result shape.
 */
export function runGrepCommand(pattern, dir, opts) {
    const root = resolve(dir);
    const contextDir = contextDirFor(root, opts.globalDir);
    const scope = deadendScope(opts);
    if (!opts.json) {
        try {
            const journal = loadDeadends(contextDir);
            // The stamp costs a walk + one stat per source file — skipped when
            // the journal is empty anyway.
            const hit = journal.length === 0 ? null :
                checkDeadend(journal, { query: pattern, scope }, statScope(root, deadendIgnore(opts.in), contextDir));
            if (hit) {
                // "No graph" still outranks a journal hit: a deleted index is a
                // caller-facing error, not a verified miss.
                if (!existsSync(wiringPath(contextDir))) {
                    console.error("✗ no graph — run grafly build first");
                    process.exit(1);
                }
                console.error(zeroHitNote({ pattern, filesSearched: hit.filesSearched ?? 0, truncated: { files: 0, hits: 0 } }));
                console.error(`[grafly] dead-end hit — '${pattern}' verified absent (scope unchanged)`);
                return;
            }
        }
        catch { /* journal unavailable or scope unstattable — search normally */ }
    }
    const graph = loadTraverseCached(contextDir);
    if (!graph) {
        console.error("✗ no graph — run grafly build first");
        process.exit(1);
    }
    let result;
    try {
        result = grepGraph(graph, root, pattern, { ignoreCase: opts.ignoreCase, fixed: opts.fixed, in: opts.in });
    }
    catch (err) {
        // `new RegExp` throws SyntaxError; anything else (an unindexed `--in` prefix)
        // is a different mistake and must not be reported as a bad pattern.
        const message = err instanceof Error ? err.message : String(err);
        console.error(err instanceof SyntaxError ? `✗ invalid pattern "${pattern}": ${message}` : `✗ ${message}`);
        process.exit(1);
        return;
    }
    if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    if (result.totalHits === 0) {
        // Journal the miss so an identical repeat on an unchanged scope is
        // free. `filesSearched` rides along so the dead-end answer can print
        // this command's usual zero-hit note verbatim.
        try {
            if (result.truncated.files > 0) throw new Error("incomplete search");
            const journal = loadDeadends(contextDir);
            recordMiss(journal, { query: pattern, scope, filesSearched: result.filesSearched, scopeFingerprint: statScope(root, deadendIgnore(opts.in), contextDir) });
            saveDeadends(contextDir, journal);
        }
        catch { /* a failed journal write must never fail the search */ }
        console.error(zeroHitNote(result));
        return;
    }
    process.stdout.write(formatGrepResult(result));
}
//# sourceMappingURL=grep-cli.js.map
