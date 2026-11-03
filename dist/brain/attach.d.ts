/**
 * Attach a brain's rules to an `ask` answer.
 *
 * The join is the symbol: a rule is mined against a graft node id, and an
 * answer is a set of hits that point at spans. Resolving the hits back to node
 * ids gives the rules that govern exactly what the agent is about to read.
 *
 * Staleness is decided HERE, on the machine that has the code: the rule carries
 * the symbol's body hash from when it was mined, and the local graph carries
 * the hash now. A mismatch means the code moved out from under the rule, which
 * is worth saying rather than hiding — a rule that describes code that no
 * longer exists is the failure mode this whole mechanism exists to catch.
 */
import type { GraphV1 } from '../graph/types.js';
import type { BrainRule } from './link.js';
/** One rule, resolved against the current graph. */
export interface AppliedRule {
    rule: string;
    /** The symbol it governs, as a `path:span` pointer the agent can open. */
    pointer: string;
    /** True when the symbol's body hash no longer matches what the rule was mined at. */
    stale: boolean;
    sourceUrl?: string;
}
/** Most rules to attach to one answer. */
export declare const MAX_ATTACHED_RULES = 6;
/** Resolve every anchored rule for status reporting, before answer display limits. */
export declare function anchoredRules(rules: BrainRule[], graph: GraphV1 | null): AppliedRule[];
/**
 * The rules governing the symbols in `pointers`, resolved against `graph`.
 *
 * Scoped to the answer, not the repo: attaching every rule a brain holds would
 * turn a token-saving pack into a token-spending one, and `ask` prints the
 * saving it claims. Capped for the same reason.
 */
export declare function rulesForPointers(pointers: string[], rules: BrainRule[], graph: GraphV1 | null): AppliedRule[];
/**
 * Render the rules block appended to an `ask` pack.
 *
 * Deliberately terse. This rides along on every answer, so it has to earn its
 * tokens: one line per rule, the pointer it governs, and a link only when there
 * is one. The `[graft]` prefix is avoided — `sumSavingsFooters` scans for
 * `[graft] tokens saved ≈` and nothing here should look like a savings line.
 */
export declare function formatRules(applied: AppliedRule[]): string[];
