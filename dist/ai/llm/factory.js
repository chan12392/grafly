import { OpenAIChatModel } from "./openai.js";
import { AnthropicChatModel } from "./anthropic.js";
import { LiteLLMChatModel } from "./litellm.js";
import { OrcaRouterChatModel } from "./orcarouter.js";
export function createChatModel(cfg) {
    switch (cfg.provider) {
        case "anthropic":
            return new AnthropicChatModel({ apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.baseUrl });
        case "openai":
            return new OpenAIChatModel({
                apiKey: cfg.apiKey,
                model: cfg.model,
                baseUrl: cfg.baseUrl,
                headers: cfg.headers,
            });
        case "litellm":
            return new LiteLLMChatModel({
                apiKey: cfg.apiKey,
                model: cfg.model,
                baseUrl: cfg.baseUrl,
                headers: cfg.headers,
            });
        case "orcarouter":
            return new OrcaRouterChatModel({
                apiKey: cfg.apiKey,
                model: cfg.model,
                baseUrl: cfg.baseUrl,
                headers: cfg.headers,
            });
        default: {
            const _exhaustive = cfg.provider;
            throw new Error(`unknown provider: ${String(_exhaustive)}`);
        }
    }
}
