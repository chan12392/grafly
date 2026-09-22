/** Bounded, literal archive lookup. Raw reads remain available for explicit retrieval. */
import { lines, readOutput } from "./runner.js";

function integer(value, fallback, min, max, name) {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`invalid ${name}`);
    return n;
}

export function searchOutput(id, options = {}) {
    const { find, archiveDir, stream } = options;
    if (typeof find !== "string" || !find.length || /[\r\n\0]/.test(find)) throw new Error("find must be a nonempty, single-line literal");
    if (options.count !== undefined) throw new Error("use --max-matches with --find; --count is for raw line ranges");
    const start = integer(options.start, 1, 1, Number.MAX_SAFE_INTEGER, "start");
    const context = integer(options.context, 1, 0, 20, "context (0..20)");
    const maxMatches = integer(options.maxMatches, 20, 1, 200, "max-matches (1..200)");
    const maxBytes = integer(options.maxBytes, 8192, 1024, 1024 * 1024, "max-bytes (1024..1048576)");
    // Verify ALL selected streams before producing even a partial search result.
    const sources = (stream === undefined ? ["stdout", "stderr"] : [stream]).map(name => {
        const data = readOutput(id, { archiveDir, stream: name });
        const source = lines(new TextDecoder("utf-8", { fatal: true }).decode(data));
        const hits = [];
        for (let i = start - 1; i < source.length; i++) if (source[i].includes(find)) hits.push(i);
        return { name, source, hits };
    });
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
    return `[grafly output ${id}; literal search; start=${start}; context=${context}]\n` + stats.join("") + body.join("");
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
