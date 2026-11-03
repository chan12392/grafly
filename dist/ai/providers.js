import { spawnSync } from "node:child_process";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";
const CODEX_PROXY_BASE_URL = "http://127.0.0.1:10531/v1";
/** Per-provider default model. */
export const DEFAULT_MODELS = {
    openai: "openai/gpt-4o-mini",
    anthropic: "claude-sonnet-5",
    // Provider-prefixed so the LiteLLM proxy routes it; override with GRAFT_MODEL.
    litellm: "openai/gpt-4o-mini",
    // Provider-prefixed so the OrcaRouter gateway routes it; override with GRAFT_MODEL.
    orcarouter: "openai/gpt-4o-mini",
};
export const DEFAULTS = {
    provider: "openai",
    model: DEFAULT_MODELS.openai,
};
/** Merge user config with environment variables and defaults. */
export function resolveConfig(config = {}) {
    const env = process.env;
    const provider = config.provider ?? env.GRAFLY_PROVIDER ?? env.GRAFT_PROVIDER ?? DEFAULTS.provider;
    const explicitKey = config.apiKey ?? env.GRAFLY_API_KEY ?? env.GRAFT_API_KEY;
    const legacyKey = env.OPENROUTER_API_KEY;
    const apiKey = explicitKey ?? legacyKey ?? env.ORCAROUTER_API_KEY;
    const usedLegacyEnv = !explicitKey && !!legacyKey;
    const model = config.model ??
        env.GRAFLY_MODEL ??
        env.GRAFT_MODEL ??
        env.GRAFLY_OPENROUTER_MODEL ??
        env.GRAFT_OPENROUTER_MODEL ??
        env.ORCAROUTER_MODEL ??
        DEFAULT_MODELS[provider];
    let baseUrl = config.baseUrl ?? env.GRAFLY_BASE_URL ?? env.GRAFT_BASE_URL ?? env.OPENROUTER_BASE_URL ?? env.ORCAROUTER_BASE_URL;
    // Back-compat: an existing setup with only OPENROUTER_API_KEY keeps hitting
    // OpenRouter without any config change.
    if (!baseUrl && provider === "openai" && usedLegacyEnv)
        baseUrl = OPENROUTER_BASE_URL;
    // The orcarouter provider points at the gateway unless a base URL is given.
    if (!baseUrl && provider === "orcarouter")
        baseUrl = ORCAROUTER_BASE_URL;
    const headers = provider === "openai" && baseUrl?.includes("openrouter.ai")
        ? { "X-Title": "grafly" }
        : undefined;
    return {
        contextDir: config.contextDir ?? env.GRAFLY_DIR ?? env.GRAFT_DIR,
        provider,
        apiKey,
        model,
        baseUrl,
        headers,
        usedLegacyEnv,
        chatModel: config.chatModel,
        synthesizer: config.synthesizer,
        summarizer: config.summarizer,
        cruxSummarizer: config.cruxSummarizer,
    };
}
/**
 * Best-effort probe for a keyless local OpenAI-compatible endpoint — the
 * codex-oauth proxy that runs beside some of our deployments
 * (127.0.0.1:10531). Called only when an LLM pass was requested and no API
 * key exists, so normal commands never pay the probe. Model pick order:
 * GRAFLY_MODEL, then preferredLocalModel, then the first listed. Override the
 * endpoint with GRAFLY_AMBIENT_URL.
 */
/** Local-proxy default for LLM passes: gpt-6.1-terra, then any terra, then a luna id. */
export function preferredLocalModel(ids) {
    return ids.find((id) => id === "gpt-6.1-terra") ?? ids.find((id) => /terra/i.test(id)) ?? ids.find((id) => /luna/i.test(id));
}
export function ambientLlmConfig(env = process.env) {
    const url = (env.GRAFLY_AMBIENT_URL ?? CODEX_PROXY_BASE_URL).replace(/\/+$/, "");
    const r = spawnSync("curl", ["-fsS", "-m", "2", `${url}/models`], { encoding: "utf8", windowsHide: true });
    if (r.error || r.status !== 0)
        return null;
    let ids = [];
    try {
        ids = (JSON.parse(r.stdout)?.data ?? []).map((m) => m.id).filter(Boolean);
    }
    catch {
        ids = [];
    }
    const model = env.GRAFLY_MODEL ?? preferredLocalModel(ids) ?? ids[0];
    if (!model)
        return null;
    return { provider: "openai", apiKey: "local", baseUrl: url, model };
}
