import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { residentCommands, cliOptions, searchCommands, buildCommand, callersCommand } from "./commands.js";

export const requestEnv = /^(GRAFLY_|GRAFT_|OPENROUTER_|ORCAROUTER_|CODEX_(?:HOME|THREAD_ID)$|CLAUDECODE$|CLAUDE_CONFIG_DIR$|MC_(?:LEARNING_HOME|MODEL_HOME|MODEL_DISABLED|ROOT|PYTHON)$|DO_NOT_TRACK$|PATH$|PATHEXT$)/i;

export const searchHome = () => resolve(process.env.GRAFLY_SEARCH_HOME || join(homedir(), ".grafly", "search-service"));
export const searchEndpoint = () => process.platform === "win32"
    ? "\\\\.\\pipe\\grafly-search-" + createHash("sha256").update(searchHome()).digest("hex").slice(0, 20)
    : join(searchHome(), "search.sock");
export const packageRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export function searchConfig() {
    try { return { xerjUrl: "embedded", ...JSON.parse(readFileSync(join(searchHome(), "config.json"), "utf8").replace(/^\uFEFF/, "")) }; }
    catch { return { xerjUrl: "embedded" }; }
}
function state() {
    try { return JSON.parse(readFileSync(join(searchHome(), "state.json"), "utf8")); }
    catch { return null; }
}
export function serviceRequest(request, timeout = request.action === "search" ? 0 : 30000) {
    const saved = state();
    if (!saved || (request.action === "search" && saved.packageRoot !== packageRoot)) return Promise.resolve(null);
    return new Promise((done) => {
        const socket = connect(searchEndpoint());
        let data = "", settled = false, dispatched = false;
        const finish = (value) => {
            if (settled) return;
            settled = true; socket.destroy();
            // A build may have committed files even when its reply was lost.
            // Never launch a second build as an automatic fallback after send.
            done(value ?? (dispatched && request.command === "build" ? { stdout: "", exitCode: 1,
                stderr: "Grafly build response interrupted; the build may still be running. Check daemon status before retrying.\n" } : null));
        };
        socket.setEncoding("utf8");
        socket.setTimeout(1000, () => finish(null));
        socket.on("error", () => finish(null));
        socket.on("end", () => finish(null));
        socket.on("connect", () => {
            socket.setTimeout(timeout);
            dispatched = true;
            socket.write(JSON.stringify({ ...request, token: saved.token, protocol: 1 }) + "\n");
        });
        socket.on("data", (chunk) => {
            data += chunk;
            if (data.length > 64 * 1024 * 1024) return finish(null);
            const end = data.indexOf("\n");
            if (end < 0) return;
            try { finish(JSON.parse(data.slice(0, end))); }
            catch { finish(null); }
        });
    });
}
export async function parseResidentRequest(argv, cwd = process.cwd()) {
    const { Command } = await import("commander");
    const program = new Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} });
    cliOptions(program);
    let request;
    searchCommands(program, (command, query, dir, opts) => {
        request = { command, query, dir, opts: { ...opts, contextDir: program.opts().dir }, cwd };
    });
    buildCommand(program).action(() => { request = { command: "build", argv, cwd }; });
    callersCommand(program).action(() => { request = { command: "callers", argv, cwd }; });
    try { await program.parseAsync(argv, { from: "user" }); }
    catch { return null; }
    return request;
}
export async function tryResidentSearch(argv) {
    const saved = state();
    if (process.env.GRAFLY_NO_DAEMON === "1" || !saved || !argv.some((a) => residentCommands.includes(a))) return false;
    const request = await parseResidentRequest(argv);
    if (!request) return false;
    // Old services cannot accept a newly routed mutating command. Fall back
    // before delivery, rather than guessing after an interrupted build.
    if (["build", "callers"].includes(request.command) && !saved.commands?.includes(request.command)) return false;
    // An older service ignores read-only and would refresh the graph; answer locally instead.
    if ((request.opts?.readOnly || process.env.GRAFLY_READONLY === "1") && !saved.features?.includes("read-only")) return false;
    // A read-only build is refused by the local CLI; never hand it to a service that might run it.
    if (request.command === "build" && (process.env.GRAFLY_READONLY === "1" || argv.includes("--read-only"))) return false;
    request.env = Object.fromEntries(Object.entries(process.env).filter(([key]) => requestEnv.test(key)));
    const response = await serviceRequest({ action: "search", ...request });
    if (!response || !Number.isInteger(response.exitCode) || typeof response.stdout !== "string" || typeof response.stderr !== "string") return false;
    process.stdout.write(response.stdout);
    process.stderr.write(response.stderr);
    process.exitCode = response.exitCode;
    return true;
}
