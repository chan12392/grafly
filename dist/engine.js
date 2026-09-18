/**
 * The Context Graph Engine.
 *
 * Two operations, no database:
 *   - {@link Graft.init}  build `.context/` from a code repo.
 *   - {@link Graft.check} report whether `.context/` is still in
 *     sync with the code (for CI).
 *
 * The graph is a folder of linked markdown files committed to the repo; git is
 * the sync. This class wires the configured LLM provider into the build/check
 * pipelines; an API key is required for any LLM-backed operation.
 */
import { resolveConfig } from "./ai/providers.js";
import { ChatSynthesizer } from "./ai/synthesize.js";
import { ChatSummarizer } from "./ai/summarize.js";
import { ChatCruxSummarizer } from "./ai/crux.js";
import { createChatModel } from "./ai/llm/factory.js";
import { buildContext, CODE_EXTENSIONS } from "./context/build.js";
import { checkContext } from "./context/check.js";
import { buildGraph } from "./graph/build.js";
import { checkGraph } from "./graph/check.js";
import { ask } from "./ask/ask.js";
export { CODE_EXTENSIONS };
export class Graft {
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
     * Build `.context/graph.json` — a per-symbol code graph from tree-sitter.
     * Tier-1 (structure) always runs; the Tier-2 meaning layer runs only when
     * `opts.llm` is set. Either way the prior meaning layer is preserved.
     */
    graph(dir, opts = {}) {
        return buildGraph(dir, {
            contextDir: this.cfg.contextDir,
            summarizer: opts.llm ? this.cruxSummarizer() : undefined,
            concurrency: opts.concurrency,
            reuse: opts.reuse,
            lsp: opts.lsp,
            onlyDirs: opts.onlyDirs,
            onProgress: opts.onProgress,
        });
    }
    /**
     * Answer a plain-words query from the committed `graft/` graph — the active
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
    _chatModel;
    /** The configured transport, or a clear error telling the user how to set a key. */
    chatModel() {
        if (this.cfg.chatModel)
            return this.cfg.chatModel;
        if (this._chatModel)
            return this._chatModel;
        if (!this.cfg.apiKey) {
            throw new Error("No API key. Set GRAFT_API_KEY (and GRAFT_PROVIDER / GRAFT_BASE_URL / GRAFT_MODEL " +
                "for your provider) to build or summarize the graph.");
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
//# sourceMappingURL=engine.js.map