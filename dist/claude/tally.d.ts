/** Did this reply tell the user what graft saved? */
export declare function hasSavingsTally(text: string): boolean;
/** One turn's worth of assistant prose, plus the id of the entry it ended on. */
export interface AssistantTurn {
    /** `uuid` of the last assistant entry, so the same reply is never counted twice. */
    uuid: string;
    /** Every text block the agent emitted since the last user prompt, joined. */
    text: string;
}
/** What the last turn's input tokens cost, alongside how many there were. The
 * pair is what a blended rate is made of; neither half means much alone. */
export interface TurnBilling {
    /** `uuid` of the last assistant entry, so a repeated Stop can't bill a turn twice. */
    uuid: string;
    /** Micro-dollars this turn's input tokens cost, cache multipliers applied. */
    costMicros: number;
    /** Input tokens billed this turn, cached and fresh alike. */
    tokens: number;
}
/**
 * The assistant prose of the turn the transcript ends on, or null when it can't
 * be read (no path — a host whose Stop hook doesn't name one — unreadable file,
 * or a tail with no assistant text in it).
 *
 * Null is meaningfully different from "no tally found": a turn we cannot observe
 * is left out of BOTH the numerator and the denominator by the caller, so a host
 * that exposes no transcript reports no ratio rather than a ratio of zero.
 *
 * Sidechain entries (subagents) are skipped throughout — a subagent's own prose
 * is never what the user read.
 */
export declare function lastAssistantTurn(transcriptPath: unknown): AssistantTurn | null;
/**
 * What the turn the transcript ends on cost in input tokens — the measured
 * half of the dollar figure the statusline and the turn nudge report.
 *
 * Costed per API response, not per turn, so a turn that switched models is
 * priced correctly rather than labelled with whichever model happened to go
 * last. Responses are deduped by `message.id`: one response is written to the
 * transcript as several entries (a `thinking` block and a `tool_use` block land
 * on their own lines) and every one of them repeats the same `usage`, so
 * summing the lines would bill the turn two or three times over.
 *
 * Null when there is nothing to bill — no transcript path (a host whose Stop
 * hook names none), an unreadable file, a turn whose entries carry no `usage`,
 * or a model with no price in {@link inputUsdPerMtok}. As everywhere in this
 * file, null means "not observed", never "zero".
 */
export declare function lastTurnBilling(transcriptPath: unknown): TurnBilling | null;
//# sourceMappingURL=tally.d.ts.map