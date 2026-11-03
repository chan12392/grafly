import type { Summarizer } from "./summarize.js";
import type { Synthesizer } from "./synthesize.js";
import type { CruxSummarizer } from "./crux.js";
import type { ChatModel } from "./llm/types.js";
import type { ProviderKind } from "./llm/factory.js";
/**
 * User-facing configuration. Anything omitted falls back to environment
 * variables and then to sensible defaults.
 *
 * Grafly is vendor-neutral: `provider` names only the WIRE FORMAT, not a company.
 * `openai` speaks the OpenAI-compatible API — point `baseUrl` at OpenRouter,
 * Fireworks, a LiteLLM proxy, Groq, a local server, or OpenAI itself, and pass
 * your own key. `anthropic` speaks the native Messages API. Any LLM-backed
 * operation needs an API key.
 */
export interface EngineConfig {
    /** Where the graph lives. Env: GRAFLY_DIR (legacy: GRAFT_DIR). Default: `<repo>/grafly`. */
    contextDir?: string;
    /** Wire format / SDK. Env: GRAFLY_PROVIDER (legacy: GRAFT_PROVIDER). Default: `openai`. */
    provider?: ProviderKind;
    /** API key for the chosen provider. Env: GRAFLY_API_KEY (legacy: GRAFT_API_KEY / OPENROUTER_API_KEY). */
    apiKey?: string;
    /** Model id. Env: GRAFLY_MODEL (legacy: GRAFT_MODEL). Provider-specific default. */
    model?: string;
    /** Base URL for OpenAI-compatible endpoints. Env: GRAFLY_BASE_URL (legacy: GRAFT_BASE_URL). */
    baseUrl?: string;
    /** Override the whole transport (skips provider/apiKey/baseUrl). */
    chatModel?: ChatModel;
    /** Override the synthesizer. */
    synthesizer?: Synthesizer;
    /** Override the code summarizer. */
    summarizer?: Summarizer;
    /** Override the per-symbol crux summarizer. */
    cruxSummarizer?: CruxSummarizer;
}
/** Fully-resolved configuration with all defaults applied. */
export interface ResolvedConfig {
    contextDir?: string;
    provider: ProviderKind;
    apiKey?: string;
    model: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    /** True when the key came from the deprecated OPENROUTER_* fallback. */
    usedLegacyEnv: boolean;
    chatModel?: ChatModel;
    synthesizer?: Synthesizer;
    summarizer?: Summarizer;
    cruxSummarizer?: CruxSummarizer;
}
/** Per-provider default model. */
export declare const DEFAULT_MODELS: Record<ProviderKind, string>;
export declare const DEFAULTS: {
    readonly provider: ProviderKind;
    readonly model: string;
};
/** Merge user config with environment variables and defaults. */
export declare function resolveConfig(config?: EngineConfig): ResolvedConfig;
/** Local-proxy default for LLM passes: gpt-6.1-terra, then any terra, then a luna id. */
export declare function preferredLocalModel(ids: string[]): string | undefined;
/** Probe the keyless local endpoint for an explicitly requested LLM pass. */
export declare function ambientLlmConfig(env?: Record<string, string | undefined>): {
    provider: "openai";
    apiKey: string;
    baseUrl: string;
    model: string;
} | null;
