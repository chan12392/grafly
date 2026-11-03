/**
 * LiteLLM transport. A LiteLLM proxy speaks the OpenAI-compatible wire format,
 * so this reuses the OpenAI adapter's request/response translation and simply
 * points it at the proxy. The value over a bare `openai` provider + `baseUrl`
 * is a first-class, self-describing provider: a sensible default proxy address
 * and `/v1/models` auto-discovery (see {@link listLiteLLMModels}), so callers
 * can enumerate whatever models the proxy is configured to serve — reaching
 * 100+ providers (OpenAI, Anthropic, Gemini, Bedrock, Vertex, …) through one
 * endpoint without a per-vendor code path.
 */
import OpenAI from "openai";
import { OpenAIChatModel, type OpenAIChatModelOptions } from "./openai.js";
/** Conventional local address of a self-hosted LiteLLM proxy. */
export declare const DEFAULT_LITELLM_BASE_URL = "http://localhost:4000";
export type LiteLLMChatModelOptions = OpenAIChatModelOptions;
/**
 * ChatModel backed by a LiteLLM proxy. Inherits every translation detail from
 * {@link OpenAIChatModel} (the proxy is OpenAI-compatible) and only changes the
 * defaults: the proxy base URL and a `litellm:<model>` label.
 */
export declare class LiteLLMChatModel extends OpenAIChatModel {
    constructor(opts: LiteLLMChatModelOptions);
}
/**
 * Auto-discover the models a LiteLLM proxy is serving via `GET /v1/models`.
 * Returns the model ids so a caller can present/validate them instead of
 * hardcoding a model string. A stub `client` may be injected for tests.
 */
export declare function listLiteLLMModels(opts: {
    apiKey: string;
    baseUrl?: string;
    client?: OpenAI;
}): Promise<string[]>;
