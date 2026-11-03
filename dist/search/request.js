import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { nearestGraflyRoot } from "../graph/root.js";
import { readWorkspace, federateAskAsync, federateGrep } from "../graph/workspace.js";
import { contextDirFor } from "../context/node-file.js";
import { setInputRate } from "../context/savings.js";
import { sessionInputRate } from "../claude/session-metrics.js";
import { askAsync, formatAsk, hitFiles } from "../ask/ask.js";
import * as answers from "../ask/answer-cache.js";
import { loadTraverseCached } from "../graph/load.js";
import { grepGraph } from "./grep.js";
import { formatGrepResult, zeroHitNote } from "./grep-cli.js";
import { syncXerj, xerjStatus, xerjStatePath } from "./xerj.js";
import { searchConfig } from "./client.js";
import { scheduleLocalBrain } from "../brain/local.js";
const syncRetryAfter = new Map();

// The CLI and resident service use the same refresh, cache and rendering path.
export async function executeSearch({ command, query, dir, cwd = process.cwd(), opts = {} }) {
    let stderr = "";
    // Read-only answers from the saved graph: no refresh, XERJ sync or answer-cache write.
    const readOnly = opts.readOnly === true || process.env.GRAFLY_READONLY === "1";
    const found = dir === undefined ? nearestGraflyRoot(cwd, opts.contextDir) : { root: resolve(cwd, dir), levels: 0 };
    const root = found.root;
    if (found.levels > 0) stderr += `[grafly] no .grafly/ here — answering from ${root}/.grafly\n`;
    setInputRate(sessionInputRate(root));
    try {
        const ws = readWorkspace(root, opts.contextDir);
        if (opts.refresh !== false && !readOnly) {
            const { ensureFreshGraph, ensureFreshChildren, refreshNote } = await import("../graph/refresh.js");
            const refreshed = ws ? await ensureFreshChildren(root, ws.children, { contextDir: opts.contextDir })
                : await ensureFreshGraph(root, { contextDir: opts.contextDir });
            const note = refreshNote(refreshed);
            if (note) stderr += note + "\n";
        }
        if (command === "grep") {
            let result, coverage;
            if (ws) ({ result, coverage } = federateGrep(root, opts.contextDir, query, opts));
            else {
                const graph = loadTraverseCached(contextDirFor(root, opts.contextDir));
                if (!graph) throw new Error("no graph — run grafly build first");
                try { result = grepGraph(graph, root, query, opts); }
                catch (error) { if (error instanceof SyntaxError) throw new Error(`invalid pattern "${query}": ${error.message}`); throw error; }
            }
            const stdout = opts.json ? JSON.stringify(result, null, 2) + "\n" : result.totalHits ? formatGrepResult(result) + (coverage ? coverage + "\n" : "") : "";
            if (!opts.json && !result.totalHits) stderr += zeroHitNote(result) + (coverage ? "\n" + coverage : "") + "\n";
            return { stdout, stderr, exitCode: 0, root, hit: result.totalHits > 0 };
        }
        const xerjUrl = searchConfig().xerjUrl;
        if (xerjUrl && opts.xerj !== false && !readOnly) {
            for (const child of ws ? ws.children.map((name) => join(root, name)) : [root]) {
                const out = contextDirFor(child, ws ? undefined : opts.contextDir);
                const status = xerjStatus(out);
                // Explicit per-repo disconnect remains an opt-out from defaults.
                if (!status.enabled && existsSync(xerjStatePath(out))) continue;
                if ((!status.fresh || status.endpoint !== xerjUrl) && Date.now() >= (syncRetryAfter.get(out) || 0)) {
                    try {
                        await syncXerj(child, out, xerjUrl, xerjUrl === "embedded" ? {} : { signal: AbortSignal.timeout(3000) });
                        syncRetryAfter.delete(out);
                    }
                    catch { syncRetryAfter.set(out, Date.now() + 30000); }
                }
            }
        }
        if (ws) {
            const r = await federateAskAsync(root, opts.contextDir, query, { ...opts, limit: Number(opts.limit ?? 8) });
            return { stdout: opts.json ? JSON.stringify(r, null, 2) + "\n" : formatAsk(r), stderr, exitCode: 0, root, hit: !!r.hits.length };
        }
        const ctxDir = contextDirFor(root, opts.contextDir);
        const key = answers.cacheKey(query, opts, root);
        const cache = answers.loadAnswers(ctxDir);
        const cached = answers.lookup(cache, key);
        if (cached && answers.verify(root, cached)) {
            const note = `[grafly] answer cache hit — ${Object.keys(cached.stamp).length} file(s) verified unchanged; replayed without re-walking the graph.\n`;
            return { stdout: cached.text + (opts.json ? "" : "\n" + note), stderr: stderr + (opts.json ? note : ""), exitCode: 0, root };
        }
        const r = await askAsync(root, query, { ...opts, limit: Number(opts.limit ?? 8) });
        const stdout = opts.json ? JSON.stringify(r, null, 2) + "\n" : formatAsk(r);
        if (!r.searchBackend?.fallback && !readOnly) {
            try {
                answers.store(cache, key, { text: stdout, files: answers.stampFiles(root, [...hitFiles(r.hits), ...answers.indexDeps(ctxDir, root)]) });
                answers.saveAnswers(ctxDir, cache);
            } catch { /* cache writes never break retrieval */ }
        }
        return { stdout, stderr, exitCode: 0, root, hit: !!r.hits.length };
    } catch (error) {
        return { stdout: "", stderr: stderr + `✗ ${error.message}\n`, exitCode: 1, root };
    } finally {
        if (!readOnly) scheduleLocalBrain(root);
    }
}
