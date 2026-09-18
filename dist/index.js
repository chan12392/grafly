/**
 * Graft — public API.
 *
 * The graph is a folder of linked markdown files (`.context/`) committed to the
 * repo. Build it from code, then check it stays in sync.
 *
 * @example
 * ```ts
 * import { Graft } from "@nanonets/graft";
 *
 * const engine = new Graft();
 * await engine.init(".");             // writes .context/*.md + manifest.json
 *
 * const result = engine.check(".");   // { ok: boolean, ...drift }
 * if (!result.ok) process.exitCode = 1;
 * ```
 */
export { Graft, CODE_EXTENSIONS } from "./engine.js";
export { buildContext } from "./context/build.js";
export { checkContext, formatCheckReport } from "./context/check.js";
export { checkGraph, formatGraphCheckReport } from "./graph/check.js";
export { resolveConfig, DEFAULTS, DEFAULT_MODELS } from "./ai/providers.js";
export { createChatModel } from "./ai/llm/factory.js";
export { OpenAIChatModel } from "./ai/llm/openai.js";
export { AnthropicChatModel } from "./ai/llm/anthropic.js";
export { LiteLLMChatModel, listLiteLLMModels, DEFAULT_LITELLM_BASE_URL } from "./ai/llm/litellm.js";
export { OrcaRouterChatModel, listOrcaRouterModels, DEFAULT_ORCAROUTER_BASE_URL } from "./ai/llm/orcarouter.js";
// Engine ops, for advanced/custom setups.
export { ChatSynthesizer } from "./ai/synthesize.js";
export { ChatSummarizer } from "./ai/summarize.js";
export { ChatCruxSummarizer } from "./ai/crux.js";
//# sourceMappingURL=index.js.map