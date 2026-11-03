import { recoverToolArgsFromContent, warnToolChoiceIgnored } from "./llm/recover-tool.js";
function isTruncatedStop(reason) {
    if (!reason)
        return false;
    const r = reason.toLowerCase();
    return r === "length" || r === "max_tokens";
}
/** Classify an empty/unusable crux reply. `null` means at least one usable summary. */
export function classifyCruxMiss(res, parsed) {
    const finishReason = res.stopReason;
    if (parsed.some((p) => p.summary.trim()))
        return null;
    if (isTruncatedStop(finishReason))
        return { kind: "truncated", finishReason };
    if (parsed.length > 0)
        return { kind: "empty-parsed", finishReason };
    const emptyTools = res.toolCalls.length === 0;
    const emptyText = !res.text?.trim();
    if (emptyTools && emptyText)
        return { kind: "empty-toolCalls", finishReason };
    return { kind: "unparseable", finishReason };
}
/** Per-file error text: miss class + the provider's finish_reason (#235). */
export function formatCruxMiss(kind, finishReason) {
    const fr = finishReason == null || finishReason === "" ? "null" : finishReason;
    return `model returned no usable symbol summaries [${kind}, finish_reason=${fr}]`;
}
const SYSTEM_PROMPT = `You explain code definitions for a code graph that helps engineers navigate a codebase.

You are given ONE source file with 1-based line numbers, and a list of TARGET definitions in it. Describe EVERY target via the record_symbols tool.

Rules:
- Return EXACTLY ONE entry for EVERY target id, using that id verbatim. The number of entries you return MUST equal the number of targets. Never omit a target: a reply missing any id is invalid and will be re-requested.
- A trivial symbol is NOT an exception. You still return it — with a one-sentence summary and crux 0/0 (see below). "Skip" means "give it no crux span", NEVER "leave it out".
- summary: ONE sentence — what the symbol is FOR at the business-logic level (the problem it solves or the rule it enforces), not a restatement of its signature.
- crux_start / crux_end: FILE line numbers (as shown), inside that symbol's own line range. Pick the SINGLE most important contiguous span — the core branch, formula, guard, or state change — at most ~8 lines, and NEVER the whole function. When there is no single focal span (a trivial getter, a plain data holder, a one-line delegation, or logic spread evenly), use crux_start: 0 and crux_end: 0. That 0/0 IS the answer — do not drop the entry.`;
const RECORD_TOOL = "record_symbols";
const SYMBOLS_SCHEMA = {
    type: "object",
    properties: {
        symbols: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    summary: { type: "string" },
                    crux_start: { type: "number" },
                    crux_end: { type: "number" },
                },
                required: ["id", "summary", "crux_start", "crux_end"],
            },
        },
    },
    required: ["symbols"],
};
/** Cap the file text sent per request so one huge file can't blow the context. */
const MAX_CODE_CHARS = 18_000;
function numberLines(source) {
    const clipped = source.length > MAX_CODE_CHARS ? `${source.slice(0, MAX_CODE_CHARS)}\n… (truncated)` : source;
    return clipped
        .split("\n")
        .map((line, i) => `${i + 1}\t${line}`)
        .join("\n");
}
function userContent(input) {
    const targets = input.nodes
        .map((n) => `- id=${n.id} | ${n.kind} | lines L${n.startLine}-L${n.endLine}` +
        (n.signature ? ` | ${n.signature}` : ""))
        .join("\n");
    const n = input.nodes.length;
    return `FILE: ${input.path}\n\n${numberLines(input.source)}\n\nTARGETS (${n} — return all ${n}, one entry per id):\n${targets}`;
}
/** Normalize the tool's parsed argument object into a {@link NodeCrux} list. */
function parseResults(obj) {
    if (!obj || !Array.isArray(obj.symbols))
        return [];
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
    return obj.symbols
        .map((s) => s)
        .filter((s) => typeof s.id === "string")
        .map((s) => ({
        id: s.id,
        summary: typeof s.summary === "string" ? s.summary.trim() : "",
        crux_start: num(s.crux_start),
        crux_end: num(s.crux_end),
    }));
}
/**
 * Some OpenAI-compatible gateways ignore forced `tool_choice` and put the tool
 * payload in `content` instead (plain `{symbols:…}`, fenced JSON, or an emulated
 * `[{name, parameters}]` array). Without this recovery the meaning pass sees an
 * empty `toolCalls` list, leaves every node `pending`, and `graft check` loops
 * on "run --deep" forever (#172; same trigger as #129 for the crux path).
 */
function argsFromResponse(res) {
    const call = res.toolCalls.find((c) => c.name === RECORD_TOOL) ?? res.toolCalls[0];
    if (call?.args && typeof call.args === "object" && !Array.isArray(call.args)) {
        return call.args;
    }
    const recovered = recoverToolArgsFromContent(res.text, {
        toolNames: [RECORD_TOOL, "emit_json"],
        payloadKey: "symbols",
    });
    if (!recovered)
        warnToolChoiceIgnored("crux", res.text?.trim() ? "unparsed" : "empty");
    return recovered;
}
/** Crux summarizer backed by any {@link ChatModel} via forced tool calling. */
export class ChatCruxSummarizer {
    model;
    lastMiss = null;
    constructor(model) {
        this.model = model;
    }
    async describeFile(input) {
        this.lastMiss = null;
        if (input.nodes.length === 0)
            return [];
        const res = await this.model.create({
            temperature: 0,
            maxTokens: 8192,
            tools: [
                {
                    name: RECORD_TOOL,
                    description: "Record each target definition's purpose and crux line range.",
                    parameters: SYMBOLS_SCHEMA,
                },
            ],
            responseFormat: { kind: "tool", name: RECORD_TOOL },
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userContent(input) },
            ],
        });
        const parsed = parseResults(argsFromResponse(res));
        this.lastMiss = classifyCruxMiss(res, parsed);
        return parsed;
    }
}
