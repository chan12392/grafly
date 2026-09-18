/**
 * What a saved token was actually worth, in dollars.
 *
 * `savings.ts` answers "how many input tokens did graft keep out of the
 * context"; this answers "what does an input token cost here". The two are
 * deliberately separate: the token count is arithmetic over file sizes and is
 * true everywhere, while the price depends on which model the session ran and
 * how much of its context was served from cache — facts only the host's
 * transcript knows.
 *
 * Nothing here guesses. There is no default rate and no env override: a model
 * we don't have a price for yields null, and the callers then render the token
 * count alone rather than a dollar figure we made up. A wrong number on the
 * statusline is worse than no number.
 */
/** List input price for a model id, or null when we don't know it — a model
 * released after this table was written, or a host reporting something else
 * entirely. Null propagates all the way to "render tokens only". */
export declare function inputUsdPerMtok(model: unknown): number | null;
/** One turn's input-token usage, as the host's transcript reports it. */
export interface TurnUsage {
    model: string;
    /** Fresh tokens, billed at the list rate. */
    input: number;
    /** Written to the cache this turn — a 25% premium over list. */
    cacheCreate: number;
    /** Served from cache — a tenth of list, and usually the bulk of a long turn. */
    cacheRead: number;
}
/** What this turn's input tokens cost, in micro-dollars, or null on a model we
 * have no price for. */
export declare function turnInputCostMicros(usage: TurnUsage): number | null;
/** Every input token this turn was billed for, cached or not — the denominator
 * of the blended rate. */
export declare function turnInputTokens(usage: TurnUsage): number;
/**
 * Dollars saved, at the rate the session has actually been paying.
 *
 * `costMicros / tokensBilled` is the blended price of one input token here —
 * model and cache-hit ratio already folded in — so this re-blends as the
 * session goes rather than freezing turn one's rate. Returns null when nothing
 * has been sampled yet (turn one, or a host whose hooks name no transcript).
 */
export declare function dollarsSaved(savedTokens: number, costMicros: number | undefined, tokensBilled: number | undefined): number | null;
/** `$1.23`, or `<$0.01` for a real but sub-cent saving. Never `$0.00`: a
 * rounded-to-nothing number reads as "graft saved you nothing", which is a
 * different claim from "graft saved you less than a cent". */
export declare function formatDollars(usd: number): string;
//# sourceMappingURL=price.d.ts.map