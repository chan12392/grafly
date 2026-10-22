/**
 * Grafly's local graph engine. `graph` builds the regenerable .grafly index;
 * `ask` retrieves synchronously and `askAsync` can use local XERJ candidates.
 * Structural queries and ranking remain in Grafly. The legacy prose init/check
 * APIs are retained. LLM configuration is needed only for an LLM-backed pass.
 */
import { resolveConfig, ambientLlmConfig } from "./ai/providers.js";
import { ChatSynthesizer } from "./ai/synthesize.js";
import { ChatSummarizer } from "./ai/summarize.js";
import { ChatCruxSummarizer } from "./ai/crux.js";
import { createChatModel } from "./ai/llm/factory.js";
import { buildContext, CODE_EXTENSIONS } from "./context/build.js";
import { checkContext } from "./context/check.js";
import { buildGraph } from "./graph/build.js";
import { checkGraph } from "./graph/check.js";
import { ask, askAsync } from "./ask/ask.js";
export { CODE_EXTENSIONS };
export class Grafly {
    cfg;
    constructor(config = {}) {
        this.cfg = resolveConfig(config);
    }
    /** Build the `.context/` graph from the repo at `dir`. */
    async init(dir, opts = {}) {
        return buildContext(dir, {
            contextDir: this.cfg.contextDir,
            extensions: opts.extensions,
            onlyDirs: opts.onlyDirs,
            model: this.modelLabel(),
            summarizer: this.summarizer(),
            synthesizer: this.synthesizer(),
            onProgress: opts.onProgress,
        });
    }
    /** Report whether the committed `.context/` markdown graph is in sync with the code. */
    check(dir, opts = {}) {
        return checkContext(dir, { contextDir: this.cfg.contextDir, extensions: opts.extensions });
    }
    /** Report whether the committed `graph.json` is in sync with the code (Tier-1 diff).
     * Async because the breadth tier warms WASM grammars before re-extraction. */
    checkGraph(dir) {
        return checkGraph(dir, { contextDir: this.cfg.contextDir });
    }
    /**
     * Build `.grafly/.graph/wiring.json` — a per-symbol graph from tree-sitter.
     * Tier-1 (structure) always runs; the Tier-2 meaning layer runs only when
     * `opts.llm` is set. Either way the prior meaning layer is preserved.
     */
    graph(dir, opts = {}) {
        return buildGraph(dir, {
            contextDir: this.cfg.contextDir,
            summarizer: opts.llm ? this.cruxSummarizer() : undefined,
            vision: opts.vision ? this.chatModel() : undefined,
            extensions: opts.extensions,
            concurrency: opts.concurrency,
            reuse: opts.reuse,
            lsp: opts.lsp,
            onlyDirs: opts.onlyDirs,
            onProgress: opts.onProgress,
        });
    }
    /**
     * Answer a plain-words query from the local `.grafly/` graph — the active
     * channel. Deterministic and $0: routes structural queries to the wiring
     * edges and everything else to a lexical rank over concepts + symbols.
     */
    ask(dir, query, opts = {}) {
        return ask(dir, query, {
            contextDir: this.cfg.contextDir,
            limit: opts.limit,
            source: opts.source,
            full: opts.full,
            in: opts.in,
            graphRank: opts.graphRank,
        });
    }
    /** Optional XERJ candidate retrieval, with Grafly ranking and local fallback. */
    askAsync(dir, query, opts = {}) {
        return askAsync(dir, query, { ...opts, contextDir: this.cfg.contextDir });
    }
    _chatModel;
    /** The configured transport, or a clear error telling the user how to set a key. */
    chatModel() {
        if (this.cfg.chatModel)
            return this.cfg.chatModel;
        if (this._chatModel)
            return this._chatModel;
        if (!this.cfg.apiKey) {
            // Before erroring, probe for a keyless local endpoint (the
            // codex-oauth proxy on our deployments, or an SSH tunnel to it).
            // Only reached when an LLM pass was actually requested.
            const ambient = ambientLlmConfig();
            if (ambient) {
                this.cfg.provider = ambient.provider;
                this.cfg.apiKey = ambient.apiKey;
                this.cfg.model = ambient.model;
                this.cfg.baseUrl = ambient.baseUrl;
                this.cfg.headers = undefined;
            }
            else {
                throw new Error("No API key. Set GRAFLY_API_KEY (and GRAFLY_PROVIDER / GRAFLY_BASE_URL / GRAFLY_MODEL " +
                    "for your provider) to build or summarize the graph.");
            }
        }
        this._chatModel = createChatModel({
            provider: this.cfg.provider,
            apiKey: this.cfg.apiKey,
            model: this.cfg.model,
            baseUrl: this.cfg.baseUrl,
            headers: this.cfg.headers,
        });
        return this._chatModel;
    }
    synthesizer() {
        return this.cfg.synthesizer ?? new ChatSynthesizer(this.chatModel());
    }
    /** Per-node crux summarizer for the code graph's Tier-2 pass. */
    cruxSummarizer() {
        return this.cfg.cruxSummarizer ?? new ChatCruxSummarizer(this.chatModel());
    }
    summarizer() {
        return this.cfg.summarizer ?? new ChatSummarizer(this.chatModel());
    }
    /** Human label for the active model, recorded in the manifest. */
    modelLabel() {
        if (this.cfg.chatModel)
            return this.cfg.chatModel.label;
        if (this.cfg.synthesizer || this.cfg.summarizer || this.cfg.cruxSummarizer)
            return "custom";
        return `${this.cfg.provider}:${this.cfg.model}`;
    }
}
/** @deprecated Compatibility alias for pre-Grafly integrations. */
export const Graft = Grafly;
