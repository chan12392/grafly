/**
 * Human formatter for `grafly grep` results. Kept out of grep.js (pure core,
 * unit-testable against hand-built fixture graphs) so the single-repo and
 * workspace surfaces render the identical report.
 */
import { withSavings } from "../context/savings.js";
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
