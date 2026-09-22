/** Own the process and raw evidence. MC only proposes retained line ranges. */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, constants } from "node:os";
import { fileURLToPath } from "node:url";
import { pinRuntime, validatePinned } from "../mc-runtime/runtime.js";

const LIMIT = 4 * 1024 * 1024;
const MINIMUM = 4096;
const KILL_GRACE_MS = 2000;
export const archiveRoot = () => resolve(process.env.GRAFLY_OUTPUT_DIR || join(homedir(), ".grafly", "tool-output"));
export const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

const READ_COMMANDS = new Set(["cat", "head", "tail"]);
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
    const result = spawnSync(pinned?.python || env.MC_PYTHON || "python", ["-I", "-S", "-B", "-X", "utf8", "-c", code, root], {
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

export function applyRanges(text, stream) {
    const source = lines(text);
    if (!stream || !Array.isArray(stream.keep)) throw new Error("invalid_ranges");
    let end = 0, result = "";
    for (const range of stream.keep) {
        if (!Array.isArray(range) || range.length !== 2) throw new Error("invalid_ranges");
        const [a, b] = range;
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < end || b <= a || b > source.length) throw new Error("invalid_ranges");
        result += source.slice(a, b).join(""); end = b;
    }
    if (Buffer.byteLength(result) !== stream.output_bytes) throw new Error("invalid_output_bytes");
    return result;
}

export async function runCommand(command, args = [], options = {}) {
    const env = options.env ?? process.env;
    const pinned = pinRuntime(env); // An in-flight command retains its starting version.
    const stdout = options.stdout ?? process.stdout, stderr = options.stderr ?? process.stderr;
    const root = resolve(options.archiveDir ?? archiveRoot());
    const id = randomUUID(), dir = join(root, id);
    // Create evidence storage before running; if it cannot be created, run once
    // with inherited output instead. Never replay a completed command.
    let archived = true, files = {}, hashes = {}, sizes = { stdout: 0, stderr: 0 };
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
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
        elapsed_ms: Date.now() - started, streams: {}, verdict: "passthrough", reason: live ? "streamed" : "not_reduced" };
    if (pinned?.metadata) manifest.mc_runtime = { version: pinned.metadata.version, sequence: pinned.metadata.sequence, sha256: pinned.metadata.sha256 };
    for (const name of ["stdout", "stderr"]) if (archived) manifest.streams[name] = { bytes: sizes[name], sha256: hashes[name].digest("hex") };
    const kind = classifyCommand(command, args);
    if (kind) manifest.kind = kind;
    const exitMeaning = exitCode === 1 && sizes.stderr === 0 ? exitOneMeaning(command, args) : null;
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
            const result = (options.judge ?? judge)({ ...input, kind, exit_code: exitCode, complete: true,
                exit_one_is_result: Boolean(exitMeaning) }, env, pinned);
            const decision = result.decision;
            if (decision.verdict === "reduced") {
                const candidate = Object.fromEntries(["stdout", "stderr"].map(s => [s, applyRanges(input[s], decision.streams?.[s])]));
                const bytes = Buffer.byteLength(candidate.stdout) + Buffer.byteLength(candidate.stderr);
                if (bytes + 512 < size && bytes < size * 0.9) {
                    reduced = candidate;
                    manifest.verdict = "reduced"; manifest.reason = result.reason_codes?.[0] ?? "reduced";
                    manifest.input_bytes = size; manifest.output_bytes = bytes; manifest.ranges = decision.streams;
                    manifest.lines = Object.fromEntries(["stdout", "stderr"].map(s => {
                        const st = decision.streams?.[s] ?? {};
                        const total = st.total_lines ?? lines(input[s]).length;
                        return [s, { shown: st.shown_lines ?? total - (st.removed_lines ?? 0), total }];
                    }));
                }
            }
        } catch (error) { manifest.reason = error.message; }
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
    return { ...manifest, exit_code: exitCode, archive: archived ? dir : null };
}

export function readOutput(id, { archiveDir = archiveRoot(), stream = "stdout", start = 1, count } = {}) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error("invalid output ID");
    if (!["stdout", "stderr"].includes(stream)) throw new Error("stream must be stdout or stderr");
    if (!Number.isInteger(start) || start < 1 || (count !== undefined && (!Number.isInteger(count) || count < 1))) throw new Error("invalid line range");
    const dir = join(resolve(archiveDir), id);
    const meta = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const data = readFileSync(join(dir, `${stream}.bin`));
    if (meta.schema !== "grafly.tool-output.v1" || meta.id !== id || data.length !== meta.streams[stream]?.bytes
        || createHash("sha256").update(data).digest("hex") !== meta.streams[stream]?.sha256) throw new Error("raw output integrity mismatch");
    if (start === 1 && count === undefined) return data;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return Buffer.from(lines(text).slice(start - 1, count === undefined ? undefined : start - 1 + count).join(""));
}
