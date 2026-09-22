/** Own the process and raw evidence. MC only proposes retained line ranges. */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, constants } from "node:os";
import { fileURLToPath } from "node:url";

const LIMIT = 4 * 1024 * 1024;
const MINIMUM = 4096;
export const archiveRoot = () => resolve(process.env.GRAFLY_OUTPUT_DIR || join(homedir(), ".grafly", "tool-output"));
export const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

export function isTestCommand(command, args) {
    const name = command.replaceAll("\\", "/").split("/").at(-1).toLowerCase().replace(/\.exe$/, "");
    if (/^python(?:3(?:\.\d+)?)?$/.test(name)) {
        for (let i = 0; i < args.length; i++) {
            if (args[i] === "-m") return ["unittest", "pytest"].includes(args[i + 1]);
            if (["-X", "-W"].includes(args[i])) { i++; continue; }
            if (!/^(?:-[IBEisSuOPqv]|-OO|-X.+|-W.+)$/.test(args[i])) return false;
        }
        return false;
    }
    return name === "pytest" || (name === "node" && args[0] === "--test" && !args.includes("-e") && !args.includes("--eval"))
        || (["npm", "pnpm"].includes(name) && (args[0] === "test" || (args[0] === "run" && args[1] === "test")));
}

function judge(payload, env) {
    const sibling = fileURLToPath(new URL("../../../morecoffee", import.meta.url));
    const root = env.MC_ROOT ? resolve(env.MC_ROOT) : existsSync(join(sibling, "morecoffee", "channels", "tool_output_stdio.py")) ? sibling : "";
    const code = "import runpy,sys; root=sys.argv[1]; sys.path.insert(0,root) if root else None; runpy.run_module('morecoffee.channels.tool_output_stdio',run_name='__main__')";
    const result = spawnSync(env.MC_PYTHON || "python", ["-I", "-X", "utf8", "-c", code, root], {
        input: JSON.stringify(payload), encoding: "utf8", env, windowsHide: true, timeout: 5000, maxBuffer: LIMIT * 2,
        // Isolated Python never imports code from the command's working directory.
        cwd: dirname(fileURLToPath(import.meta.url)),
    });
    if (result.error || result.status !== 0) throw new Error("mc_unavailable");
    const parsed = JSON.parse(result.stdout);
    if (parsed.status !== "ok" || parsed.channel_id !== "tool_output") throw new Error("mc_abstained");
    return parsed.decision;
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
    let timedOut = false, interrupted = false;
    // Native host owns normal cancellation. Explicit runner timeout terminates
    // the child tree so late grandchildren cannot keep the pipe alive.
    const kill = (signal = "SIGTERM") => {
        if (!child.pid) return;
        if (process.platform === "win32") spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else try { process.kill(-child.pid, signal); } catch { /* exited meanwhile */ }
    };
    const signalHandlers = Object.fromEntries(["SIGINT", "SIGTERM"].map(s => [s, () => { interrupted = true; kill(s); }]));
    for (const [s, handler] of Object.entries(signalHandlers)) process.on(s, handler);
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs) : null;
    let spawnError;
    child.on("error", (err) => { spawnError = err; });
    const completion = await new Promise((accept) => child.on("close", (code, signal) => accept({ code, signal })));
    if (timer) clearTimeout(timer);
    for (const [s, handler] of Object.entries(signalHandlers)) process.off(s, handler);
    for (const fd of Object.values(files)) try { closeSync(fd); } catch { archived = false; }
    const exitCode = spawnError ? 127 : timedOut ? 124 : completion.code ?? (128 + (constants.signals[completion.signal] ?? 15));
    const manifest = { schema: "grafly.tool-output.v1", id, command, args, cwd: resolve(options.cwd ?? process.cwd()),
        exit_code: exitCode, signal: completion.signal, complete: !spawnError && !timedOut && !interrupted && completion.code !== null,
        elapsed_ms: Date.now() - started, streams: {}, verdict: "passthrough", reason: live ? "streamed" : "not_reduced" };
    for (const name of ["stdout", "stderr"]) if (archived) manifest.streams[name] = { bytes: sizes[name], sha256: hashes[name].digest("hex") };
    let reduced = null;
    if (!live && archived && exitCode === 0 && manifest.complete && size >= MINIMUM && isTestCommand(command, args)) {
        try {
            const decoder = new TextDecoder("utf-8", { fatal: true });
            const input = Object.fromEntries(["stdout", "stderr"].map(s => [s, decoder.decode(Buffer.concat(buffers[s]))]));
            // NUL/binary output is never interpreted as a test transcript.
            if (input.stdout.includes("\0") || input.stderr.includes("\0")) throw new Error("binary_output");
            const decision = judge({ ...input, kind: "test", exit_code: exitCode, complete: true }, env);
            if (decision.verdict === "reduced") {
                const candidate = Object.fromEntries(["stdout", "stderr"].map(s => [s, applyRanges(input[s], decision.streams?.[s])]));
                const bytes = Buffer.byteLength(candidate.stdout) + Buffer.byteLength(candidate.stderr);
                if (bytes + 512 < size && bytes < size * 0.9) {
                    reduced = candidate;
                    manifest.verdict = "reduced"; manifest.reason = "passing_test_details";
                    manifest.input_bytes = size; manifest.output_bytes = bytes; manifest.ranges = decision.streams;
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
        stderr.write(`\n[grafly tool_output: ${size} -> ${manifest.output_bytes} bytes; raw=${dir}; retrieve: grafly output ${id}]\n`);
    } else if (!live) flush();
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
