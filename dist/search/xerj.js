/** Optional local XERJ candidate index. Grafly owns files, graph and ranking;
 * XERJ holds a regenerable projection of the complete ask token bags. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR } from "../context/node-file.js";
import { askIndexPath, tokenize } from "../ask/index-file.js";
import { matchesIdentifier, queryIdentifiers } from "../ask/exact-symbol.js";
import { isTestPath, queryWantsTests } from "../ask/query.js";
import { loadAskIndexCached, loadGraphCached } from "../graph/load.js";
import { wiringPath } from "../graph/write.js";
import { normalizePathPrefix } from "../util/paths.js";
import { pathUnderPrefix } from "../graph/scopes.js";
import { readJson, writeJsonAtomic } from "../util/state.js";

const VERSION = 1;
export const xerjStatePath = (outDir) => join(outDir, CACHE_DIR, "xerj.json");

function localEndpoint(value) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/")
        throw new Error("XERJ must be a loopback HTTP(S) endpoint, e.g. http://127.0.0.1:9200");
    return url.origin;
}

export function readXerjState(outDir) {
    const state = readJson(xerjStatePath(outDir));
    if (!state || state.version !== VERSION || !state.enabled)
        return null;
    try {
        return { ...state, endpoint: localEndpoint(state.endpoint) };
    }
    catch { return null; }
}

function sourceStamp(outDir) {
    return [wiringPath(outDir), askIndexPath(outDir)].map((path) => {
        const s = statSync(path);
        return [s.mtimeMs, s.size];
    });
}

function sameStamp(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

async function request(endpoint, path, { method = "GET", body, ndjson = false, timeout = 1000 } = {}) {
    const key = process.env.GRAFLY_XERJ_API_KEY;
    const res = await fetch(`${endpoint}${path}`, {
        method,
        redirect: "error",
        headers: {
            ...(body === undefined ? {} : { "content-type": ndjson ? "application/x-ndjson" : "application/json" }),
            ...(key ? { authorization: `ApiKey ${key}` } : {}),
        },
        body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok)
        throw new Error(`XERJ HTTP ${res.status}`);
    return res.json();
}

function bagText(bag) {
    // Preserve every term and its frequency, including the end of large bodies.
    return bag.map(([term, count]) => `${term} `.repeat(count)).join("");
}

/** Sync every graph node, publishing the manifest only after all bulk writes
 * succeed. Physical indexes are scoped to checkout + content generation, so a
 * failed/new build cannot alter the previously published search generation. */
export async function syncXerj(root, outDir, endpoint) {
    const previous = readXerjState(outDir);
    if (endpoint === undefined && !previous)
        return null;
    endpoint = localEndpoint(endpoint ?? previous.endpoint);
    const stamp = sourceStamp(outDir);
    const graph = loadGraphCached(outDir);
    const sidecar = loadAskIndexCached(outDir);
    const docs = new Map(sidecar?.docs.map((doc) => [doc.id, doc]));
    if (!graph || docs.size !== graph.nodes.length || !graph.nodes.every((node) => docs.has(node.id)))
        throw new Error("Build the Grafly graph and complete ask index before connecting XERJ");
    const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 20);
    const identity = realpathSync(root);
    const generation = hash(Buffer.concat([
        Buffer.from(`grafly-xerj-${VERSION}\n`),
        readFileSync(wiringPath(outDir)), readFileSync(askIndexPath(outDir)),
    ]));
    const index = `grafly-${hash(identity)}-${generation}`;
    // Reuse a complete generation; repair it if the server lost its data.
    let present = false;
    let exists = false;
    let count;
    try {
        count = await request(endpoint, `/${index}/_count`);
        exists = true;
        present = count.count === graph.nodes.length;
    }
    catch { /* missing index or unavailable server is handled by the write */ }
    if (count?.count > graph.nodes.length)
        throw new Error("XERJ generation contains unexpected documents");
    if (!present) {
        if (!exists) await request(endpoint, `/${index}`, { method: "PUT", timeout: 10000, body: {
            mappings: { properties: {
                name: { type: "text" }, path: { type: "text" }, body: { type: "text" },
                source_path: { type: "keyword" }, is_test: { type: "boolean" },
            } },
        } });
        let lines = [];
        let bytes = 0;
        const flush = async () => {
            if (!lines.length) return;
            const result = await request(endpoint, "/_bulk", {
                method: "POST", body: `${lines.join("\n")}\n`, ndjson: true, timeout: 30000,
            });
            if (result.errors || !Array.isArray(result.items) || result.items.length !== lines.length / 2 ||
                result.items.some((item) => !item.index || item.index.status >= 300))
                throw new Error("XERJ rejected part of the graph index; previous generation retained");
            lines = [];
            bytes = 0;
        };
        for (const node of graph.nodes) {
            const doc = docs.get(node.id);
            const action = JSON.stringify({ index: { _index: index, _id: node.id } });
            const value = JSON.stringify({ name: bagText(doc.name), path: bagText(doc.path), body: bagText(doc.body),
                source_path: node.path, is_test: isTestPath(node.path) });
            const size = Buffer.byteLength(action) + Buffer.byteLength(value) + 2;
            if (bytes + size > 1024 * 1024) await flush();
            lines.push(action, value);
            bytes += size;
        }
        await flush();
        const count = await request(endpoint, `/${index}/_count`, { timeout: 10000 });
        if (count.count !== graph.nodes.length)
            throw new Error("XERJ graph index is incomplete; previous generation retained");
    }
    if (!sameStamp(stamp, sourceStamp(outDir)))
        throw new Error("Grafly graph changed during XERJ sync; run sync again");
    const state = { version: VERSION, enabled: true, endpoint, index, generation, stamp, nodes: graph.nodes.length };
    writeJsonAtomic(xerjStatePath(outDir), state, true);
    return state;
}

export function disconnectXerj(outDir) {
    // Disconnecting never deletes source files or server indexes.
    writeJsonAtomic(xerjStatePath(outDir), { version: VERSION, enabled: false }, true);
}

export function xerjStatus(outDir) {
    const state = readXerjState(outDir);
    if (!state) return { enabled: false };
    let fresh = false;
    try { fresh = sameStamp(state.stamp, sourceStamp(outDir)); }
    catch { /* graph missing */ }
    return { enabled: true, endpoint: state.endpoint, index: state.index, nodes: state.nodes, fresh };
}

/** null candidates means run the trusted local search. Returned IDs are checked
 * against the current graph; source snippets always come from Grafly, never HTTP. */
export async function xerjCandidates(outDir, query, graph, opts = {}) {
    const status = xerjStatus(outDir);
    if (!status.enabled || opts.xerj === false)
        return { ids: null };
    if (!status.fresh || !graph)
        return { ids: null, reason: "stale index" };
    const state = readXerjState(outDir);
    if (!/^grafly-[a-f0-9]{20}-[a-f0-9]{20}$/.test(state.index))
        return { ids: null, reason: "invalid index" };
    try {
        const prefix = opts.in ? normalizePathPrefix(opts.in) : undefined;
        const nodes = graph.nodes.filter((node) => !prefix || pathUnderPrefix(node.path, prefix));
        const allowed = new Map(nodes.map((node) => [node.id, node]));
        const match = { multi_match: { query: tokenize(query).join(" "), fields: ["name^4", "path^2", "body"] } };
        const filters = prefix ? [{ bool: { should: [
            { term: { source_path: prefix } }, { prefix: { source_path: `${prefix}/` } },
        ], minimum_should_match: 1 } }] : [];
        const search = (testOnly) => request(state.endpoint, `/${state.index}/_search`, {
            method: "POST", body: {
                size: Math.min(512, Math.max(64, (opts.limit ?? 8) * 12)),
                query: { bool: { must: [match], filter: [...filters, ...(testOnly ? [{ term: { is_test: true } }] : [])] } },
                _source: false,
            },
        });
        // Test-intent queries need test evidence as well as production code. Use
        // the same policy as Grafly ranking, not a new boost or sampled file list.
        const results = await Promise.all([search(false), ...(queryWantsTests(query) ? [search(true)] : [])]);
        if (results.some((result) => !Array.isArray(result.hits?.hits))) throw new Error("invalid search response");
        const files = new Set();
        for (const hit of results.flatMap((result) => result.hits.hits)) {
            const node = allowed.get(hit._id);
            if (node) files.add(node.path);
        }
        // Keep every span in selected files, and explicit definitions even when
        // their file did not enter the retrieval window. Ranking stays in Grafly.
        const identifiers = queryIdentifiers(query);
        const ids = new Set(nodes.filter((node) => files.has(node.path) ||
            (node.kind !== "file" && matchesIdentifier(node.name, identifiers))).map((node) => node.id));
        return ids.size ? { ids } : { ids: null, reason: "no candidates in scope" };
    }
    catch {
        return { ids: null, reason: "unavailable" };
    }
}
