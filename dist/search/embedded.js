// XERJ's real FTS library runs inside the resident Grafly process.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CACHE_DIR } from "../context/node-file.js";

const require = createRequire(import.meta.url);
let binding;
const indexes = new Map();
export function embeddedBinding() {
    try { return binding ??= require(`./native/xerj-${process.platform}-${process.arch}.node`); }
    catch (error) { throw new Error(`Embedded XERJ is unavailable; run npm run build:xerj (${error.message})`); }
}
function directory(outDir, state) {
    if (typeof state.directory !== "string" || !/^grafly-[a-f0-9]{20}-[a-f0-9]{20}-[a-f0-9-]{36}$/.test(state.directory))
        throw new Error("Invalid embedded XERJ directory");
    return join(outDir, CACHE_DIR, "xerj", state.directory);
}
export function openEmbedded(outDir, state) {
    const path = directory(outDir, state);
    const prior = indexes.get(outDir);
    if (prior?.path === path) return prior.reader;
    const reader = new (embeddedBinding().XerjIndex)(path);
    if (reader.count !== state.nodes) throw new Error("Incomplete embedded XERJ index");
    indexes.set(outDir, { path, reader });
    return reader;
}
export function buildEmbedded(outDir, state, documents, previous) {
    if (previous?.endpoint === "embedded" && previous.index === state.index) {
        try { openEmbedded(outDir, previous); return previous.directory; }
        catch { /* A missing/corrupt derived cache is rebuilt before publication. */ }
    }
    const value = { ...state, directory: `${state.index}-${randomUUID()}` };
    const path = directory(outDir, value);
    mkdirSync(path, { recursive: true });
    embeddedBinding().buildIndex(path, JSON.stringify(documents));
    // Open and validate before the caller atomically publishes the manifest.
    const reader = new (embeddedBinding().XerjIndex)(path);
    if (reader.count !== state.nodes) throw new Error("Incomplete embedded XERJ index");
    return value.directory;
}
