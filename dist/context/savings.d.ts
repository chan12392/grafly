/**
 * Shared "tokens saved" estimate for every retrieval-style graft command.
 *
 * The model is always the same: baseline (what you'd have read otherwise, in
 * full) − this output (what graft handed you). The baseline is measured from
 * the `chars` the build stored on each file node, so it costs nothing and is
 * honest about the alternative — opening the files whole. When no file in the
 * baseline has a known size (a pre-`chars` graph), the estimate is omitted
 * rather than faked.
 *
 * `graft ask` keeps its own footer (it carries an escalation nudge and feeds
 * the session saved-token counter); everything else — skeleton, grep, callers,
 * map — routes through {@link savingsFor} + {@link withSavings} here.
 */
import type { GraphV1 } from '../graph/types.js';
export interface Savings {
    /** How many source files the baseline covers. */
    files: number;
    /** Total chars of those files — the "read them whole" cost. */
    baselineChars: number;
}
/** Rough tokens for a byte length (≈ 4 chars/token; good enough for an estimate). */
export declare function toTokens(chars: number): number;
/** Baseline = whole size of the distinct `paths`, summed from file-node sizes.
 * Returns undefined when not a single path has a known size — the caller then
 * omits the estimate instead of claiming a bogus one. */
export declare function savingsFor(graph: GraphV1, paths: Iterable<string>): Savings | undefined;
/** Tell this module what an input token costs here. Null clears it, and so does
 * anything that isn't a positive finite number — a NaN from a zero-denominator
 * rate must render as "no dollars known", never as `$NaN` in the agent's face. */
export declare function setInputRate(usdPerMtok: number | null): void;
/** Appended to every retrieval footer so the agent reports the turn's running
 * total even when SKILL.md isn't loaded — the instruction rides along in the
 * tool output itself. Deliberately free of the `[graft] tokens saved ≈ <n>`
 * pattern so the PostToolUse accumulator that parses these footers never
 * mistakes the nudge (or its example) for a second number to count.
 *
 * Carries this call's dollar value once a rate has been measured, because the
 * agent has no way to price a token itself — the ask it's given has to contain
 * the number, not just request one. The example phrasing stays inside what
 * `hasSavingsTally` (claude/tally.ts) recognises, so adding money here does not
 * quietly zero the reported-turns metric. */
export declare function savingsTurnNudge(savedTokens: number): string;
/** The one-line savings estimate for a command's text output, so the agent gets
 * the number for free — no extra tool call. `body` is the exact rendered output
 * the agent reads (the pack). Returns "" when there's nothing honest to claim:
 * no baseline, or the output isn't actually smaller than reading the files
 * (tiny files, where the pointers cost more than the source). */
export declare function savingsLine(body: string, saved: Savings | undefined): string;
/**
 * Sum every `[graft] tokens saved ≈ N` footer in a blob of text — the reader
 * half of {@link savingsLine}, kept next to the writer so the two never drift.
 * A single blob can carry several (an agent that made two graft calls in one
 * turn); the nudge from `savingsTurnNudge` deliberately omits the pattern, so its example
 * text is not miscounted here.
 */
export declare function sumSavingsFooters(text: string): number;
/** Render `body` with the savings line on TOP.
 *
 * Deliberately a header, not a footer: agents routinely pipe graft through
 * `head -N` (and hosts truncate long tool output from the end), which silently
 * ate the number and, with it, the PostToolUse accumulator that feeds the
 * statusline's `~N tok saved`. Every clipper keeps the head, so the number
 * survives. Emitted once — a second copy at the bottom would be double-counted
 * by that accumulator's `matchAll`. */
export declare function withSavings(body: string, saved: Savings | undefined): string;
//# sourceMappingURL=savings.d.ts.map