/**
 * Recover a forced-tool payload from assistant `content` when a gateway ignored
 * `tool_choice` and wrote JSON text instead of `tool_calls` (#129).
 *
 * Conservative: only succeeds when `text` parses as JSON matching one of:
 *   - `[{ name, parameters|arguments|args }]`
 *   - `{ name, parameters|arguments|args }`
 *   - a fenced ```json block wrapping either
 *   - a bare object whose `payloadKey` is an array
 * Anything else (prose, truncated JSON, a guessed shape) returns undefined.
 * Callers MUST run the same schema validation they use for real tool calls.
 */
export declare function recoverToolArgsFromContent(text: string, opts: {
    toolNames: readonly string[];
    payloadKey: string;
}): Record<string, unknown> | undefined;
/** One stderr line when a structured op got neither a tool call nor recoverable JSON. */
export declare function warnToolChoiceIgnored(op: string, reason: "empty" | "unparsed"): void;
