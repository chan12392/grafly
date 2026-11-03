/**
 * Native Anthropic transport. Wraps `@anthropic-ai/sdk` (the Messages API), so
 * Claude is a first-class provider rather than something tunneled through an
 * OpenAI-compatible endpoint.
 *
 * The Messages API differs from Chat Completions in ways this adapter absorbs so
 * the rest of graft never sees them:
 *   - `system` is a top-level parameter, not a message.
 *   - tool results ride inside a USER turn, and all results answering one
 *     assistant turn must be coalesced into a single user message.
 *   - `max_tokens` is required (callers get a default).
 *   - `temperature` is rejected by current models, so it is never forwarded.
 *   - structured output is a forced tool (there is no `response_format`).
 *   - assistant turns are replayed verbatim (via `providerRaw`) so thinking-block
 *     signatures survive a multi-turn loop.
 */
import Anthropic from "@anthropic-ai/sdk";
import { transportRetries } from "./types.js";
const PROVIDER = "anthropic";
const JSON_TOOL = "emit_json";
const DEFAULT_MAX_TOKENS = 4096;
const cc = (on) => (on ? { cache_control: { type: "ephemeral" } } : {});
export class AnthropicChatModel {
    label;
    client;
    model;
    constructor(opts) {
        this.model = opts.model;
        this.label = opts.label ?? `${PROVIDER}:${opts.model}`;
        this.client =
            opts.client ??
                new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl, maxRetries: transportRetries() });
    }
    async create(req) {
        const system = [];
        const messages = [];
        for (const m of req.messages) {
            if (m.role === "system") {
                system.push({ type: "text", text: m.content, ...cc(m.cacheBreakpoint) });
            }
            else if (m.role === "user") {
                messages.push({ role: "user", content: [
                    { type: "text", text: m.content, ...cc(m.cacheBreakpoint) },
                    ...(m.images ?? []).map(image => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } })),
                ] });
            }
            else if (m.role === "tool") {
                // Tool results live in a user turn; coalesce consecutive results together.
                const block = {
                    type: "tool_result",
                    tool_use_id: m.toolCallId ?? "",
                    content: [{ type: "text", text: m.content }],
                    ...cc(m.cacheBreakpoint),
                };
                const last = messages[messages.length - 1];
                if (last?.role === "user" && Array.isArray(last.content)) {
                    last.content.push(block);
                }
                else {
                    messages.push({ role: "user", content: [block] });
                }
            }
            else {
                messages.push(this.assistantParam(m));
            }
        }
        const tools = req.tools?.map(toAnthropicTool);
        const params = {
            model: this.model,
            max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
            messages,
            ...(system.length ? { system } : {}),
        };
        // temperature is intentionally NOT forwarded — current models reject it.
        const fmt = req.responseFormat ?? { kind: "text" };
        if (fmt.kind === "json") {
            params.tools = [
                ...(tools ?? []),
                { name: JSON_TOOL, description: "Return the answer as a JSON object.", input_schema: { type: "object" } },
            ];
            params.tool_choice = { type: "tool", name: JSON_TOOL };
        }
        else if (fmt.kind === "tool") {
            params.tools = tools;
            params.tool_choice = { type: "tool", name: fmt.name };
        }
        else if (tools) {
            params.tools = tools;
        }
        const resp = await this.client.messages.create(params);
        return this.fromResponse(resp, fmt.kind);
    }
    /** Reconstruct an assistant turn, replaying the original blocks when we made them. */
    assistantParam(m) {
        if (m.providerRaw?.provider === PROVIDER)
            return m.providerRaw.raw;
        const content = [];
        if (m.content)
            content.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls ?? []) {
            content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
        }
        return { role: "assistant", content };
    }
    fromResponse(resp, format) {
        let text = "";
        let toolCalls = [];
        for (const block of resp.content) {
            if (block.type === "text")
                text += block.text;
            else if (block.type === "tool_use")
                toolCalls.push({ id: block.id, name: block.name, args: block.input });
        }
        if (format === "json") {
            const jsonCall = toolCalls.find((c) => c.name === JSON_TOOL);
            if (jsonCall)
                text = JSON.stringify(jsonCall.args);
            toolCalls = toolCalls.filter((c) => c.name !== JSON_TOOL);
        }
        return {
            text,
            toolCalls,
            usage: normalizeUsage(resp.usage),
            stopReason: resp.stop_reason ?? null,
            // Replay the raw content verbatim so thinking-block signatures survive.
            assistant: {
                role: "assistant",
                content: text,
                toolCalls: toolCalls.length ? toolCalls : undefined,
                providerRaw: { provider: PROVIDER, raw: { role: "assistant", content: resp.content } },
            },
        };
    }
}
function toAnthropicTool(t) {
    return { name: t.name, description: t.description, input_schema: t.parameters };
}
/** Anthropic reports uncached input in `input_tokens` and cache tokens separately. */
function normalizeUsage(u) {
    return {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheCreate: u.cache_creation_input_tokens ?? 0,
    };
}
