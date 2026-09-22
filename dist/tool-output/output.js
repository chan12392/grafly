/** Bounded, literal archive lookup. Raw reads remain available for explicit retrieval. */
import { lines, readOutput } from "./runner.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const READ_FILE_LIMIT = 256 * 1024 * 1024;
const READ_DEFAULT_COUNT = 200;
const READ_MAX_COUNT = 10_000;
const READ_MAX_BYTES = 1024 * 1024;

function integer(value, fallback, min, max, name) {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`invalid ${name}`);
    return n;
}

// Shared literal-search body: numbered `name:line:text` rows under byte/match
// budgets, with explicit per-source counts and continuation.
function boundedSearch(sources, { header, start, context, maxMatches, maxBytes }) {
    let remainingBytes = maxBytes - 1024, remainingMatches = maxMatches;
    const body = [], stats = [];
    for (const { name, source, hits } of sources) {
        const selected = hits.slice(0, remainingMatches), shownLines = new Set();
        // Do not pull extra matches past the match limit in as trailing context.
        const endLimit = hits[selected.length] ?? source.length;
        let byteLimited = false;
        for (const hit of selected) {
            const window = [];
            for (let i = Math.max(start - 1, hit - context); i < Math.min(endLimit, hit + context + 1); i++) {
                if (!shownLines.has(i)) window.push([i, `${name}:${i + 1}:${source[i].replace(/\r?\n$/, "")}\n`]);
            }
            const size = window.reduce((sum, [, row]) => sum + Buffer.byteLength(row), 0);
            if (size > remainingBytes) { byteLimited = true; break; }
            for (const [i, row] of window) { shownLines.add(i); body.push(row); }
            remainingBytes -= size;
        }
        const shown = hits.filter(i => shownLines.has(i)).length;
        remainingMatches -= shown;
        const next = hits.find(i => !shownLines.has(i));
        stats.push(`[${name}: matches=${hits.length}; shown=${shown}; complete=${next === undefined}`
            + (next === undefined ? "" : `; next_start=${next + 1}; limit=${byteLimited ? "bytes (reduce context or raise --max-bytes)" : "matches"}`) + "]\n");
    }
    return header + stats.join("") + body.join("");
}

function searchOptions(options) {
    if (typeof options.find !== "string" || !options.find.length || /[\r\n\0]/.test(options.find)) throw new Error("find must be a nonempty, single-line literal");
    if (options.count !== undefined) throw new Error("use --max-matches with --find; --count is for raw line ranges");
    return {
        start: integer(options.start, 1, 1, Number.MAX_SAFE_INTEGER, "start"),
        context: integer(options.context, 1, 0, 20, "context (0..20)"),
        maxMatches: integer(options.maxMatches, 20, 1, 200, "max-matches (1..200)"),
        maxBytes: integer(options.maxBytes, 8192, 1024, 1024 * 1024, "max-bytes (1024..1048576)"),
    };
}

export function searchOutput(id, options = {}) {
    const { find, archiveDir, stream } = options;
    const search = searchOptions(options);
    // Verify ALL selected streams before producing even a partial search result.
    const sources = (stream === undefined ? ["stdout", "stderr"] : [stream]).map(name => {
        const data = readOutput(id, { archiveDir, stream: name });
        const source = lines(new TextDecoder("utf-8", { fatal: true }).decode(data));
        const hits = [];
        for (let i = search.start - 1; i < source.length; i++) if (source[i].includes(find)) hits.push(i);
        return { name, source, hits };
    });
    return boundedSearch(sources, { ...search, header: `[grafly output ${id}; literal search; start=${search.start}; context=${search.context}]\n` });
}

/** Bounded file/directory reads with path:line provenance. No command runs. */
export function readPath(pathArg, options = {}) {
    if (typeof pathArg !== "string" || !pathArg.length) throw new Error("usage: grafly read <path>");
    const full = resolve(pathArg);
    const stat = statSync(full); // ENOENT surfaces as a plain error.
    const start = integer(options.start, 1, 1, Number.MAX_SAFE_INTEGER, "start");
    const count = integer(options.count, READ_DEFAULT_COUNT, 1, READ_MAX_COUNT, "count");
    if (options.stream !== undefined || options.archiveDir !== undefined) throw new Error("read takes a file or directory path, not archive options");
    if (options.find === undefined && [options.context, options.maxMatches].some(v => v !== undefined))
        throw new Error("search options require --find");
    const maxBytes = integer(options.maxBytes, options.find === undefined ? READ_MAX_BYTES : 8192,
        1024, READ_MAX_BYTES, "max-bytes (1024..1048576)");
    if (stat.isDirectory()) {
        if (options.find !== undefined) throw new Error("--find is for file contents; narrow the directory path instead");
        const entries = readdirSync(full, { withFileTypes: true })
            .map(e => e.name + (e.isDirectory() ? "/" : "")).sort();
        const header = n => {
            const complete = start - 1 + n >= entries.length;
            return `[grafly read ${full}: ${entries.length} entries; shown ${n ? `${start}-${start + n - 1}` : "0"}; complete=${complete}`
                + (complete ? "" : `; continue: grafly read <path> --start ${start + n}`) + "]\n";
        };
        const shown = [];
        let bytes = 0;
        for (let i = start - 1; i < Math.min(entries.length, start - 1 + count); i++) {
            const row = entries[i] + "\n", rowBytes = Buffer.byteLength(row);
            if (bytes + rowBytes + Buffer.byteLength(header(shown.length + 1)) > maxBytes) {
                if (!shown.length) throw new Error(`directory entry ${i + 1} and metadata exceed the ${maxBytes} byte budget; raise --max-bytes`);
                break;
            }
            shown.push(row); bytes += rowBytes;
        }
        const result = header(shown.length) + shown.join("");
        if (Buffer.byteLength(result) > maxBytes) throw new Error("directory metadata exceeds the byte budget; raise --max-bytes");
        return result;
    }
    if (!stat.isFile()) throw new Error("not a regular file or directory");
    if (stat.size > READ_FILE_LIMIT) throw new Error(`file exceeds ${READ_FILE_LIMIT} bytes; use a narrower source tool`);
    const data = readFileSync(full);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (text.includes("\0")) throw new Error("binary file (NUL byte); use a binary-aware tool");
    const source = lines(text);
    if (options.find !== undefined) {
        const search = searchOptions(options);
        const hits = [];
        for (let i = search.start - 1; i < source.length; i++) if (source[i].includes(options.find)) hits.push(i);
        return boundedSearch([{ name: full, source, hits }],
            { ...search, header: `[grafly read ${full}; literal search; start=${search.start}; context=${search.context}]\n` });
    }
    // Complete lines only — a single line over budget is an explicit refusal,
    // never a silent truncation.
    const shown = [];
    let bytes = 0;
    for (let i = start - 1; i < Math.min(source.length, start - 1 + count); i++) {
        const lineBytes = Buffer.byteLength(source[i]);
        if (!shown.length && lineBytes > maxBytes)
            throw new Error(`line ${i + 1} alone is ${lineBytes} bytes, over the ${maxBytes} byte budget; use --find '<literal>' or another tool`);
        if (bytes + lineBytes > maxBytes) break;
        shown.push(source[i]); bytes += lineBytes;
    }
    const complete = start - 1 + shown.length >= source.length;
    return `[grafly read ${full}: ${source.length} lines; shown ${shown.length ? `${start}-${start + shown.length - 1}` : "0"}; ${bytes} bytes; complete=${complete}`
        + (complete ? "" : `; continue: grafly read <path> --start ${start + shown.length}`) + "]\n"
        + shown.join("");
}

// Shared by the public CLI and the lightweight host entry point.
export function writeOutput(id, options = {}, sinks = process) {
    if (options.find !== undefined) {
        sinks.stdout.write(searchOutput(id, options));
        return;
    }
    if ([options.context, options.maxMatches, options.maxBytes].some(v => v !== undefined)) throw new Error("search options require --find");
    const range = { archiveDir: options.archiveDir,
        start: integer(options.start, 1, 1, Number.MAX_SAFE_INTEGER, "start"),
        count: options.count === undefined ? undefined : integer(options.count, undefined, 1, Number.MAX_SAFE_INTEGER, "count") };
    const streams = options.stream === undefined ? ["stdout", "stderr"] : [options.stream];
    const data = streams.map(stream => readOutput(id, { ...range, stream }));
    streams.forEach((stream, i) => (options.stream ? sinks.stdout : sinks[stream]).write(data[i]));
}
