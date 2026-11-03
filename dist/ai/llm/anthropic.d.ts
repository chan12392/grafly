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
import type { ChatModel, ChatRequest, ChatResponse } from "./types.js";
export interface AnthropicChatModelOptions {
    apiKey: string;
    model: string;
    baseUrl?: string;
    label?: string;
    /** Inject a pre-built client (tests pass a stub; production omits it). */
    client?: Anthropic;
}
export declare class AnthropicChatModel implements ChatModel {
    readonly label: string;
    private client;
    private model;
    constructor(opts: AnthropicChatModelOptions);
    create(req: ChatRequest): Promise<ChatResponse>;
    /** Reconstruct an assistant turn, replaying the original blocks when we made them. */
    private assistantParam;
    private fromResponse;
}
