/** Bounded, literal archive lookup. Raw reads remain available for explicit retrieval. */
import { lines, readOutput } from "./runner.js";
import { conditionalRead, commitRead } from "./conditional.js";
import { observeComparison } from "../mc-runtime/comparison.js";
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
// budgets, with explicit per-source counts and continuation. The whole response
// — header, stats rows and body — must fit maxBytes. Stats text depends on the
// selection, so the byte budget is settled by iteration: stats only shrink as
// shown counts shrink, so one re-selection always converges.
function boundedSearch(sources, { header, start, context, maxMatches, maxBytes }) {
    let reserved = 0;
    for (;;) {
        const budget = maxBytes - Buffer.byteLength(header) - reserved;
        if (budget <= 0) throw new Error(`max-bytes ${maxBytes} cannot fit the result metadata; raise --max-bytes`);
        let remainingBytes = budget, remainingMatches = maxMatches;
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
                // A window that could not fit even the whole body budget can
                // never be delivered — a next_start pointing at it would stall
                // every retry, so refuse loudly instead.
                if (size > budget)
                    throw new Error(`match at ${name}:${hit + 1} needs ${size} bytes; the ${maxBytes} byte budget leaves ${budget} — raise --max-bytes or reduce --context`);
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
        const statsText = stats.join("");
        const statsBytes = Buffer.byteLength(statsText);
        if (statsBytes <= reserved) return header + statsText + body.join("");
        reserved = statsBytes;
    }
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
    const observed = result => {
        if (!/(?:^|[\\/])(?:\.env(?:\..*)?|auth\.json|credentials(?:\.[^\\/]+)?|\.npmrc|\.pypirc|\.ssh|\.aws|model-access)(?:[\\/]|$)/i.test(full))
            void observeComparison({ task: 'document_suitability', items: [{ id: full.length <= 128 ? full : 'read-document',
                text: result, protected: false, constraint_status: 'unknown' }] },
                { sessionId: options.sessionId, cwd: options.cwd, env: options.comparisonEnv });
        return result;
    };
    if (options.find !== undefined) {
        const search = searchOptions(options);
        const hits = [];
        for (let i = search.start - 1; i < source.length; i++) if (source[i].includes(options.find)) hits.push(i);
        return observed(boundedSearch([{ name: full, source, hits }],
            { ...search, header: `[grafly read ${full}; literal search; start=${search.start}; context=${search.context}]\n` }));
    }
    // Complete lines only — a single line over budget is an explicit refusal,
    // never a silent truncation. The header counts toward maxBytes, same as
    // the directory listing does.
    const header = (n, b) => {
        const complete = start - 1 + n >= source.length;
        return `[grafly read ${full}: ${source.length} lines; shown ${n ? `${start}-${start + n - 1}` : "0"}; ${b} bytes; complete=${complete}`
            + (complete ? "" : `; continue: grafly read <path> --start ${start + n}`) + "]\n";
    };
    const shown = [];
    let bytes = 0;
    for (let i = start - 1; i < Math.min(source.length, start - 1 + count); i++) {
        const lineBytes = Buffer.byteLength(source[i]);
        const prospective = bytes + lineBytes;
        if (prospective + Buffer.byteLength(header(shown.length + 1, prospective)) > maxBytes) {
            if (!shown.length)
                throw new Error(lineBytes > maxBytes
                    ? `line ${i + 1} alone is ${lineBytes} bytes, over the ${maxBytes} byte budget; use --find '<literal>' or another tool`
                    : `line ${i + 1} and the response header exceed the ${maxBytes} byte budget; raise --max-bytes`);
            break;
        }
        shown.push(source[i]); bytes = prospective;
    }
    // Dedup records claim "the reader holds this file's content" — only true
    // when the response covered every line (range/budget-truncated reads don't
    // qualify for either replay or recording).
    const whole = start === 1 && shown.length === source.length;
    const cond = conditionalRead(full, text, { fresh: options.fresh === true, whole, sessionId: options.sessionId });
    if (cond.replay !== null) { commitRead(cond); return cond.replay; }
    const result = header(shown.length, bytes) + shown.join("");
    if (Buffer.byteLength(result) > maxBytes) throw new Error("file metadata exceeds the byte budget; raise --max-bytes");
    commitRead(cond);
    return observed(result);
}

/** Parse a shell read invocation into {path, opts} for readPath, or null when
 *  the form isn't a simple single-file read. Flag values are consumed with
 *  their flag so `-n 5 f` has one operand, not two — canServe and serve share
 *  this parser so eligibility and behavior can never diverge. */
function readInvocation(command, args = []) {
    const name = command.replaceAll("\\", "/").split("/").at(-1).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, "");
    // Collect operands; each known flag consumes its numeric value. Unknown
    // flags or extra operands make the form unservable — run it for real.
    const operands = [];
    let flagN;
    const valueFlags = { "get-content": /^-(?:TotalCount|Tail)$/i, "gc": /^-(?:TotalCount|Tail)$/i, "head": /^-(?:n|lines)$/i, "tail": /^-(?:n|lines)$/i };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith("-")) {
            const inline = /^-(n|lines)(\d+)$/i.exec(a); // tail -n5 f
            if (inline && valueFlags[name]?.test("-" + inline[1])) {
                const n = Number(inline[2]);
                if (flagN !== undefined || !Number.isSafeInteger(n) || n < 1) return null;
                flagN = { flag: "-" + inline[1], n }; continue;
            }
            if (!valueFlags[name]?.test(a)) return null;
            if (flagN !== undefined) return null; // one range flag only
            if (!/^\d+$/.test(args[i + 1] ?? "")) return null;
            const n = Number(args[i + 1]);
            if (!Number.isSafeInteger(n) || n < 1 || args[i + 1] === undefined) return null;
            flagN = { flag: a, n }; i++;
        }
        else operands.push(a);
    }
    if (!["cat", "type", "more", "get-content", "gc", "head", "tail"].includes(name)
        || operands.length !== 1)
        return null;
    const opts = {};
    if (flagN) {
        if (/^-(?:Tail|n|lines)/i.test(flagN.flag) && name !== "head") opts.tail = flagN.n;
        else opts.count = flagN.n;
    }
    else if (["head", "tail"].includes(name)) opts[name === "head" ? "count" : "tail"] = 10;
    return { path: operands[0], opts };
}

/** Pure eligibility check for routing — unservable spellings of shell builtins
 *  (which cannot be spawned at all) must never be rewritten into `grafly run`. */
export function canServeReadCommand(command, args = []) {
    return readInvocation(command, args) !== null;
}

/**
 * Serve a routed shell read command (`cat file`, `type file`, `Get-Content
 * [-Tail N] file`, `head/tail [-n N] file`) through `readPath` instead of
 * spawning it — the conditional-read cache then dedups repeats the same way
 * `grafly read` does. Returns the output string, or null when the invocation
 * isn't a simple single-file read (let the real command run then).
 */
export function serveReadCommand(command, args = [], { cwd = process.cwd(), sessionId } = {}) {
    const inv = readInvocation(command, args);
    if (!inv) return null;
    const full = resolve(cwd, inv.path);
    if (inv.opts.tail !== undefined) { // tail: read to locate the start line; output stays budgeted
        const total = lines(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(full))).length;
        return readPath(full, { start: String(Math.max(1, total - inv.opts.tail + 1)), count: String(inv.opts.tail), sessionId });
    }
    return readPath(full, { ...(inv.opts.count !== undefined ? { count: String(inv.opts.count) } : {}), sessionId });
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
