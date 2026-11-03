/**
 * OpenAI-compatible transport. Wraps the `openai` SDK pointed at any
 * OpenAI-compatible endpoint (OpenAI, OpenRouter, Fireworks, a LiteLLM proxy,
 * Groq, Together, DeepSeek, a local server, …) — the user picks the endpoint
 * with `baseUrl` and authenticates with their own key.
 *
 * This adapter reproduces graft's historical wire behavior exactly: temperature
 * is forwarded, cache breakpoints become `cache_control` content parts (which
 * OpenRouter forwards to Anthropic), and cached tokens are subtracted out of the
 * input count so {@link Usage.input} is uncached-only.
 */
import OpenAI from "openai";
import type { ChatModel, ChatRequest, ChatResponse } from "./types.js";
export interface OpenAIChatModelOptions {
    apiKey: string;
    model: string;
    baseUrl?: string;
    /** Stable manifest label; defaults to `openai:<model>`. */
    label?: string;
    /** Extra default headers (e.g. OpenRouter's `X-Title`). */
    headers?: Record<string, string>;
    /** Inject a pre-built client (tests pass a stub; production omits it). */
    client?: OpenAI;
}
export declare class OpenAIChatModel implements ChatModel {
    readonly label: string;
    private client;
    private model;
    constructor(opts: OpenAIChatModelOptions);
    create(req: ChatRequest): Promise<ChatResponse>;
    /**
     * Wraps `chat.completions.create` with a narrow, safe fallback: if the
     * server rejects an object-form `tool_choice` and exactly one tool was
     * offered, "required" is behaviorally identical (the model has nothing
     * else to pick), so retry once with the string form instead of failing
     * the whole build. Left alone when more than one tool is offered, since
     * "required" would then let the model choose freely instead of the
     * caller-specified tool — that ambiguity isn't safe to paper over
     * automatically.
     */
    private createChatCompletion;
    private fromResponse;
}
