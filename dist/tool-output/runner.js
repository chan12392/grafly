/** Own the process and raw evidence. MC only proposes retained line ranges. */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { pinRuntime, validatePinned } from "../mc-runtime/runtime.js";
import { observeComparison, outputItems } from "../mc-runtime/comparison.js";
import { archiveRoot, startArchive, finishArchive, pruneArchives } from "./retention.js";
export { archiveRoot } from "./retention.js";

const LIMIT = 4 * 1024 * 1024;
const MINIMUM = 4096;
const KILL_GRACE_MS = 2000;
export const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

const READ_COMMANDS = new Set(["cat", "head", "tail", "more"]);
const SEARCH_COMMANDS = new Set(["rg", "grep", "egrep", "fgrep", "findstr", "find", "ls", "where", "which", "tree"]);
const NO_MATCH_COMMANDS = new Set(["rg", "grep", "egrep", "fgrep", "findstr"]);
const BUILD_COMMANDS = new Set(["npm", "pnpm", "yarn"]);
const BUILD_ACTIONS = new Set(["install", "i", "ci", "add", "remove", "update", "upgrade"]);
const GIT_KINDS = { status: "git", diff: "git", log: "git", show: "git", grep: "search", "ls-files": "search" };
// Options that consume the following argument before the subcommand.
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--namespace"]);
// git diff/show flags that turn the output into a plain listing.
const GIT_LIST_FLAGS = new Set(["--name-only", "--name-status", "--numstat", "--shortstat", "--stat",
    "--raw", "--dirstat", "--summary", "--compact-summary"]);

const commandName = command => command.replaceAll("\\", "/").split("/").at(-1).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, "");

function gitSubcommand(args) {
    for (let i = 0; i < args.length; i++) {
        if (!args[i].startsWith("-")) return args[i];
        if (GIT_VALUE_OPTS.has(args[i])) i++;
    }
    return undefined;
}

function gitKind(args) {
    const sub = gitSubcommand(args);
    const kind = GIT_KINDS[sub];
    if (!kind) return null;
    const rest = args.slice(args.indexOf(sub) + 1);
    if (kind === "git") {
        // `git show REV:PATH` prints file contents — treat as a file read.
        if (sub === "show" && rest.some(a => /^[^-].*:\S/.test(a))) return "read";
        // Listing-only diff/show forms are search-shaped output.
        if (["diff", "show"].includes(sub) && rest.some(a => GIT_LIST_FLAGS.has(a.split("=")[0]))) return "search";
    }
    return kind;
}

/** Exact supported invocation forms → MC kind; anything else stays raw. */
export function classifyCommand(command, args = []) {
    const name = commandName(command);
    if (/^python(?:3(?:\.\d+)?)?$/.test(name)) {
        for (let i = 0; i < args.length; i++) {
            if (args[i] === "-m") return ["unittest", "pytest"].includes(args[i + 1]) ? "test" : null;
            if (["-X", "-W"].includes(args[i])) { i++; continue; }
            if (!/^(?:-[IBEisSuOPqv]|-OO|-X.+|-W.+)$/.test(args[i])) return null;
        }
        return null;
    }
    if (name === "pytest" || (name === "node" && args[0] === "--test" && !args.includes("-e") && !args.includes("--eval"))
        || (["npm", "pnpm"].includes(name) && (args[0] === "test" || (args[0] === "run" && args[1] === "test")))) return "test";
    if (READ_COMMANDS.has(name)) return "read";
    if (process.platform === "win32" && command.toLowerCase() === name
        && ["type", "get-content", "gc"].includes(name)) return "read";
    if (SEARCH_COMMANDS.has(name)) return "search";
    if (BUILD_COMMANDS.has(name) && BUILD_ACTIONS.has(args[0])) return "build";
    if (name === "git") return gitKind(args);
    return null;
}

/** Exit 1 is not universally a search result: find/ls can report failures. */
export function exitOneMeaning(command, args = []) {
    const name = commandName(command);
    if (NO_MATCH_COMMANDS.has(name)) return "no_matches";
    if (name === "git") {
        const sub = gitSubcommand(args);
        if (sub === "grep") return "no_matches";
        if (sub === "diff") return "differences";
    }
    return null;
}

export const isTestCommand = (command, args) => classifyCommand(command, args) === "test";

export function judge(payload, env, pinned = pinRuntime(env)) {
    validatePinned(pinned);
    const sibling = fileURLToPath(new URL("../../../morecoffee", import.meta.url));
    const root = pinned?.root ?? (env.MC_ROOT ? resolve(env.MC_ROOT) : existsSync(join(sibling, "morecoffee", "channels", "tool_output_stdio.py")) ? sibling : "");
    const code = "import runpy,sys; root=sys.argv[1]; sys.path.insert(0,root) if root else None; runpy.run_module('morecoffee.channels.tool_output_stdio',run_name='__main__')";
    const result = spawnSync(env.MC_PYTHON || pinned?.python || "python", ["-I", "-S", "-B", "-X", "utf8", "-c", code, root], {
        input: JSON.stringify(payload), encoding: "utf8", env, windowsHide: true, timeout: 5000, maxBuffer: LIMIT * 2,
        // Isolated Python never imports code from the command's working directory.
        cwd: dirname(fileURLToPath(import.meta.url)),
    });
    if (result.error || result.status !== 0) throw new Error("mc_unavailable");
    const parsed = JSON.parse(result.stdout);
    // Older MC rejects unknown kinds as "unsupported"; that is the documented
    // raw fallback, not an error to retry.
    if (parsed.status !== "ok" || parsed.channel_id !== "tool_output") throw new Error("mc_abstained");
    return parsed;
}

export function applyRanges(text, stream, required = [], focus = []) {
    const source = lines(text);
    if (!Array.isArray(required) || required.length > 64 || required.some(range => !Array.isArray(range)
        || range.length !== 2 || !range.every(Number.isInteger) || range[0] < 0 || range[1] <= range[0] || range[1] > source.length)
        || !Array.isArray(focus) || focus.length > 16 || focus.some(term => typeof term !== 'string' || !term.length || Buffer.byteLength(term) > 256))
        throw new Error("invalid_output_hints");
    // Rewritten-text streams (e.g. lossless search path dedup) carry their
    // compressed payload directly instead of keep ranges — verified by bytes.
    if (stream && typeof stream.text === "string") {
        if (required.length || focus.length) throw new Error("original_ranges_required");
        if (Buffer.byteLength(stream.text) !== stream.output_bytes) throw new Error("invalid_output_bytes");
        return stream.text;
    }
    if (!stream || !Array.isArray(stream.keep)) throw new Error("invalid_ranges");
    let end = 0, result = "";
    for (const range of stream.keep) {
        if (!Array.isArray(range) || range.length !== 2) throw new Error("invalid_ranges");
        const [a, b] = range;
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < end || b <= a || b > source.length) throw new Error("invalid_ranges");
        result += source.slice(a, b).join(""); end = b;
    }
    if (Buffer.byteLength(result) !== stream.output_bytes) throw new Error("invalid_output_bytes");
    for (const [a, b] of required) {
        let cursor = a;
        for (const [start, stop] of stream.keep) {
            if (start > cursor || cursor >= b) break;
            cursor = Math.max(cursor, stop);
        }
        if (cursor < b) throw new Error("required_output_omitted");
    }
    let kept = 0;
    if (focus.length) for (let i = 0; i < source.length; i++) {
        while (kept < stream.keep.length && stream.keep[kept][1] <= i) kept++;
        if (focus.some(term => source[i].includes(term)) && (!stream.keep[kept] || stream.keep[kept][0] > i))
            throw new Error("focused_output_omitted");
    }
    return result;
}

function outputHints(command, args, options) {
    const hints = Object.fromEntries(['required_stdout_ranges', 'required_stderr_ranges', 'focus_terms']
        .filter(key => options[key] !== undefined).map(key => [key, options[key]]));
    // shortcut: infer only simple literal searches; other forms need explicit caller hints.
    const name = commandName(command), rest = [...args];
    if (hints.focus_terms === undefined && ['rg', 'grep', 'fgrep'].includes(name)) {
        while (['-n', '--line-number'].includes(rest[0])) rest.shift();
        if (['-F', '--fixed-strings'].includes(rest[0])) rest.shift();
        else if (name !== 'fgrep') return hints;
        while (['-n', '--line-number'].includes(rest[0])) rest.shift();
        const terminated = rest[0] === '--';
        if (terminated) rest.shift();
        if (rest[0] && (terminated || rest.every(arg => !arg.startsWith('-')))) hints.focus_terms = [rest[0]];
    }
    return hints;
}

export async function runCommand(command, args = [], options = {}) {
    const env = options.env ?? process.env;
    const pinned = pinRuntime(env); // An in-flight command retains its starting version.
    const tool = { name: command, arguments: { argv: args }, scope: resolve(options.cwd ?? process.cwd()),
        effects: ['execute'], purpose: 'The caller requested this command; no independent scope judgment is available.' };
    // Optional metadata must fit the MC contract without truncating the caller's actual command.
    const typed = typeof command === 'string' && command.trim() && Buffer.byteLength(command) <= 256
        && Buffer.byteLength(tool.scope) <= 4096 && args.length <= 64
        && args.every(arg => typeof arg === 'string' && Buffer.byteLength(arg) <= 8192)
        && Buffer.byteLength(JSON.stringify(tool)) <= 16384;
    await observeComparison({ task: 'tool_call_suitability', items: [{ id: 'proposed-call',
        text: JSON.stringify({ command, args, purpose: 'The caller requested this command; no independent scope judgment is available.' }),
        protected: false, constraint_status: 'unknown', ...(typed ? { tool } : {}) }] },
        { cwd: options.cwd, sessionId: options.sessionId, env });
    // Shell wrappers stay raw. Serve only simple, directly invoked file reads.
    // Preservation hints require validation against the original command streams.
    if (env.GRAFLY_TOOL_OUTPUT !== "0" && options.required_stdout_ranges === undefined
        && options.required_stderr_ranges === undefined && options.focus_terms === undefined) {
        try {
            const { serveReadCommand } = await import("./output.js");
            if (classifyCommand(command, args) === "read") {
                const out = serveReadCommand(command, args, {
                    cwd: options.cwd, sessionId: options.sessionId === undefined ? env.GRAFLY_SESSION_ID : options.sessionId,
                });
                if (out !== null) {
                    (options.stdout ?? process.stdout).write(out);
                    return { exit_code: 0, archive: null, served: "read-path" };
                }
            }
        } catch { /* serve failure → run the real command */ }
    }
    const stdout = options.stdout ?? process.stdout, stderr = options.stderr ?? process.stderr;
    const root = resolve(options.archiveDir ?? archiveRoot());
    pruneArchives({ root });
    const id = randomUUID(), dir = join(root, id);
    // Create evidence storage before running; if it cannot be created, run once
    // with inherited output instead. Never replay a completed command.
    // GRAFLY_TOOL_OUTPUT=0 disables archiving entirely — output streams live.
    let archived = env.GRAFLY_TOOL_OUTPUT !== "0", files = {}, hashes = {}, sizes = { stdout: 0, stderr: 0 };
    try {
        if (!archived) throw new Error("tool_output_disabled");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        startArchive(dir, id);
        for (const name of ["stdout", "stderr"]) {
            files[name] = openSync(join(dir, `${name}.bin`), "wx", 0o600);
            hashes[name] = createHash("sha256");
        }
    } catch {
        archived = false;
        for (const fd of Object.values(files)) try { closeSync(fd); } catch { /* already closed */ }
        files = {};
    }
    let buffers = { stdout: [], stderr: [] }, size = 0, live = !archived;
    const started = Date.now();
    const child = spawn(command, args, { cwd: options.cwd, env, windowsHide: true, shell: false,
        detached: process.platform !== "win32", stdio: ["inherit", "pipe", "pipe"] });
    const sinks = { stdout, stderr };
    const flush = () => {
        for (const name of ["stdout", "stderr"]) {
            for (const chunk of buffers[name]) sinks[name].write(chunk);
            buffers[name] = [];
        }
        live = true;
    };
    for (const name of ["stdout", "stderr"]) child[name].on("data", (chunk) => {
        sizes[name] += chunk.length; size += chunk.length;
        if (archived) {
            try {
                let offset = 0;
                while (offset < chunk.length) offset += writeSync(files[name], chunk, offset);
                hashes[name].update(chunk);
            }
            catch { archived = false; flush(); }
        }
        if (live) sinks[name].write(chunk);
        else { buffers[name].push(chunk); if (size > LIMIT) flush(); }
    });
    let timedOut = false, interrupted = false, killTimer = null;
    // Native host owns normal cancellation. Explicit runner timeout terminates
    // the child tree: SIGTERM to the process group, a bounded grace, then
    // SIGKILL — a child that ignores SIGTERM must not hold the runner open.
    // (win32: taskkill /T /F is already the forced tree kill.)
    const kill = (signal = "SIGTERM") => {
        if (!child.pid) return;
        if (process.platform === "win32") {
            spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
            return;
        }
        try { process.kill(-child.pid, signal); } catch { /* exited meanwhile */ }
        if (!killTimer) {
            killTimer = setTimeout(() => {
                try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
                // An heir that escaped the group can still pin our pipes;
                // destroy them so `close` is not hostage to a dead tree.
                for (const s of [child.stdout, child.stderr]) try { s.destroy(); } catch { /* closed */ }
            }, KILL_GRACE_MS);
            killTimer.unref();
        }
    };
    const signalHandlers = Object.fromEntries(["SIGINT", "SIGTERM"].map(s => [s, () => { interrupted = true; kill(s); }]));
    for (const [s, handler] of Object.entries(signalHandlers)) process.on(s, handler);
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs) : null;
    let spawnError;
    child.on("error", (err) => { spawnError = err; });
    const completion = await new Promise((accept) => child.on("close", (code, signal) => accept({ code, signal })));
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    for (const [s, handler] of Object.entries(signalHandlers)) process.off(s, handler);
    for (const fd of Object.values(files)) try { closeSync(fd); } catch { archived = false; }
    const exitCode = spawnError ? 127 : timedOut ? 124 : completion.code ?? (128 + (constants.signals[completion.signal] ?? 15));
    const manifest = { schema: "grafly.tool-output.v1", id, command, args, cwd: resolve(options.cwd ?? process.cwd()),
        exit_code: exitCode, signal: completion.signal, complete: !spawnError && !timedOut && !interrupted && completion.code !== null,
        started_at: new Date(started).toISOString(), finished_at: new Date().toISOString(),
        elapsed_ms: Date.now() - started, streams: {}, verdict: "passthrough", reason: live ? "streamed" : "not_reduced" };
    if (pinned?.metadata) manifest.mc_runtime = { version: pinned.metadata.version, sequence: pinned.metadata.sequence, sha256: pinned.metadata.sha256 };
    for (const name of ["stdout", "stderr"]) if (archived) manifest.streams[name] = { bytes: sizes[name], sha256: hashes[name].digest("hex") };
    const kind = classifyCommand(command, args);
    if (kind) manifest.kind = kind;
    const exitMeaning = exitCode === 1 && sizes.stderr === 0 ? exitOneMeaning(command, args) : null;
    manifest.mc_attempted = false;
    manifest.reason = env.GRAFLY_TOOL_OUTPUT === "0" ? "disabled" : !archived ? "archive_unavailable"
        : !manifest.complete ? "incomplete_output" : !(exitCode === 0 || exitMeaning) ? "command_failed"
        : live ? "streamed" : !kind ? "unsupported_command"
        : size < MINIMUM ? "output_too_small" : "not_reduced";
    let reduced = null;
    // Only known command semantics with no diagnostics allow an exit-1 result.
    // Unsupported kinds and shell wrappers never reach MC.
    if (!live && archived && manifest.complete && size >= MINIMUM && kind
        && (exitCode === 0 || exitMeaning)) {
        try {
            const decoder = new TextDecoder("utf-8", { fatal: true });
            const input = Object.fromEntries(["stdout", "stderr"].map(s => [s, decoder.decode(Buffer.concat(buffers[s]))]));
            // NUL/binary output is never interpreted as a text transcript.
            if (input.stdout.includes("\0") || input.stderr.includes("\0")) throw new Error("binary_output");
            manifest.mc_attempted = true;
            const hints = outputHints(command, args, options);
            const result = (options.judge ?? judge)({ ...input, kind, exit_code: exitCode, complete: true,
                exit_one_is_result: Boolean(exitMeaning), ...hints }, env, pinned);
            const decision = result.decision;
            manifest.mc_reason_codes = result.reason_codes ?? [];
            manifest.reason = result.reason_codes?.[0] ?? "mc_passthrough";
            if (decision.verdict === "reduced") {
                const candidate = Object.fromEntries(["stdout", "stderr"].map(s => [s,
                    applyRanges(input[s], decision.streams?.[s], hints[`required_${s}_ranges`], hints.focus_terms)]));
                const bytes = Buffer.byteLength(candidate.stdout) + Buffer.byteLength(candidate.stderr);
                if (bytes + 512 < size && bytes < size * 0.9) {
                    reduced = candidate;
                    manifest.verdict = "reduced"; manifest.reason = result.reason_codes?.[0] ?? "reduced";
                    manifest.input_bytes = size; manifest.output_bytes = bytes;
                    // Keep the decision for audit, but never duplicate a rewritten
                    // stream's full text into the manifest — its size marker suffices.
                    manifest.ranges = Object.fromEntries(Object.entries(decision.streams).map(([s, st]) =>
                        [s, st && typeof st.text === "string" ? { ...st, text: `<${st.text.length} chars>` } : st]));
                    manifest.lines = Object.fromEntries(["stdout", "stderr"].map(s => {
                        const st = decision.streams?.[s] ?? {};
                        const total = st.total_lines ?? lines(input[s]).length;
                        return [s, { shown: st.shown_lines ?? total - (st.removed_lines ?? 0), total }];
                    }));
                } else {
                    manifest.reason = "insufficient_savings";
                }
            }
        } catch (error) { manifest.reason = error.message; }
    }
    if (archived && manifest.complete && !live && size <= 60000) {
        try {
            const decoder = new TextDecoder('utf-8', { fatal: true });
            const input = ['stdout', 'stderr'].map(name => decoder.decode(Buffer.concat(buffers[name])));
            if (!input.some(text => text.includes('\0'))) {
                const items = outputItems(...input, exitCode !== 0);
                // Search/diff exit 1 can be a result: retain existing guards without claiming failure.
                if (exitMeaning) for (const item of items) delete item.role;
                if (items.length) await observeComparison({ task: 'input_block_retention', items },
                    { cwd: options.cwd, sessionId: options.sessionId, env });
            }
        } catch { /* Keep the original output on any observation failure. */ }
    }
    if (archived) {
        try { writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
        catch { archived = false; reduced = null; }
    }
    if (reduced && archived) {
        stdout.write(reduced.stdout); stderr.write(reduced.stderr);
        const shown = Object.values(manifest.lines).reduce((a, s) => a + s.shown, 0);
        const total = Object.values(manifest.lines).reduce((a, s) => a + s.total, 0);
        stderr.write(`\n[grafly tool_output: kind=${kind}; ${size} -> ${manifest.output_bytes} bytes; ${shown}/${total} lines; exit=${exitCode}; id=${id}; find details: grafly output ${id} --find '<literal>'; ranges: --stream <stdout|stderr> --start <line> --count <lines>]\n`);
    } else if (!live) flush();
    // A recognized search exiting 1 with no output is a legitimate no-match,
    // not an execution error — say so explicitly.
    if (!reduced && exitMeaning === "no_matches" && sizes.stdout === 0)
        stderr.write("[grafly tool_output: no matches; exit=1]\n");
    if (spawnError) stderr.write(`grafly run: ${spawnError.message}\n`);
    if (timedOut) stderr.write("grafly run: command timed out\n");
    finishArchive(dir, id);
    const retention = pruneArchives({ root });
    const expired = retention.deleted.includes(id);
    if (expired) stderr.write(`[grafly tool_output: raw archive expired under the 20 MiB budget; id=${id}]\n`);
    return { ...manifest, exit_code: exitCode, archive: archived && !expired ? dir : null };
}

export function readOutput(id, { archiveDir = archiveRoot(), stream = "stdout", start = 1, count } = {}) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error("invalid output ID");
    if (!["stdout", "stderr"].includes(stream)) throw new Error("stream must be stdout or stderr");
    if (!Number.isInteger(start) || start < 1 || (count !== undefined && (!Number.isInteger(count) || count < 1))) throw new Error("invalid line range");
    const dir = join(resolve(archiveDir), id);
    let meta, data;
    try {
        meta = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        data = readFileSync(join(dir, `${stream}.bin`));
    } catch (error) {
        if (error.code === "ENOENT") throw new Error(`raw output unavailable: ${id}; it may have expired under the 20 MiB retention budget`);
        throw error;
    }
    if (meta.schema !== "grafly.tool-output.v1" || meta.id !== id || data.length !== meta.streams[stream]?.bytes
        || createHash("sha256").update(data).digest("hex") !== meta.streams[stream]?.sha256) throw new Error("raw output integrity mismatch");
    if (start === 1 && count === undefined) return data;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return Buffer.from(lines(text).slice(start - 1, count === undefined ? undefined : start - 1 + count).join(""));
}
