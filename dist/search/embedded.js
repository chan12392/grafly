// XERJ's real FTS library runs inside the resident Grafly process.
import { createRequire } from "node:module";
import { mkdirSync, lstatSync, readdirSync, realpathSync, unlinkSync, rmdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { CACHE_DIR } from "../context/node-file.js";
import { safeRoot, sameFile } from "../util/retention.js";

const require = createRequire(import.meta.url);
let binding;
const indexes = new Map();
const DIRECTORY = /^grafly-[a-f0-9]{20}-[a-f0-9]{20}-[a-f0-9-]{36}$/;
const CACHE_FILE = /^(?:ids\.json|grafly\.ftsan|grafly\.(?:name|path|body|scope|test)\.(?:fst|post|meta|norms))$/;
export function embeddedBinding() {
    try { return binding ??= require(`./native/xerj-${process.platform}-${process.arch}.node`); }
    catch (error) { throw new Error(`Embedded XERJ is unavailable; run npm run build:xerj (${error.message})`); }
}
function directory(outDir, state) {
    if (typeof state.directory !== "string" || !DIRECTORY.test(state.directory))
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

/** Caller holds the cache lock and has already published the current manifest. */
export function pruneEmbedded(outDir, state) {
    try {
        const root = safeRoot(join(outDir, CACHE_DIR, "xerj"));
        const keep = new Set([state.directory, state.previousDirectory]);
        const active = indexes.get(outDir)?.path;
        for (const name of readdirSync(root)) {
            if (!DIRECTORY.test(name) || !name.startsWith(state.index.slice(0, 28)) || keep.has(name)) continue;
            const path = resolve(root, name);
            if (dirname(path) !== root || path === active) continue;
            try {
                const dir = lstatSync(path);
                if (!dir.isDirectory() || dir.isSymbolicLink() || realpathSync(path) !== path) continue;
                const files = readdirSync(path).map(name => ({ name, stat: lstatSync(join(path, name)) }));
                if (files.some(({ name, stat }) => !CACHE_FILE.test(name) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) continue;
                // Only unlink known files: existing native readers retain their mmap snapshots.
                for (const file of files) {
                    const target = join(path, file.name), current = lstatSync(target);
                    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !sameFile(file.stat, current)) break;
                    unlinkSync(target);
                }
                rmdirSync(path);
            } catch { /* Windows may hold an mmap open; retry after its reader exits. */ }
        }
    } catch { /* Cleanup must never invalidate a successfully published index. */ }
}
