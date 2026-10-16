import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
export function serviceRequest(request, timeout = 30000) {
    const saved = state();
    if (!saved || (request.action === "search" && saved.packageRoot !== packageRoot)) return Promise.resolve(null);
    return new Promise((done) => {
        const socket = connect(searchEndpoint());
        let data = "", settled = false;
        const finish = (value) => { if (!settled) { settled = true; socket.destroy(); done(value); } };
        socket.setEncoding("utf8");
        socket.setTimeout(timeout, () => finish(null));
        socket.on("error", () => finish(null));
        socket.on("end", () => finish(null));
        socket.on("connect", () => socket.write(JSON.stringify({ ...request, token: saved.token, protocol: 1 }) + "\n"));
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
export async function tryResidentSearch(argv) {
    if (process.env.GRAFLY_NO_DAEMON === "1" || !state() || !argv.some((a) => a === "ask" || a === "grep")) return false;
    const [{ Command }, { searchCommands }] = await Promise.all([import("commander"), import("./commands.js")]);
    const program = new Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} });
    program.option("--dir <path>");
    let request;
    searchCommands(program, (command, query, dir, opts) => {
        request = { command, query, dir, opts: { ...opts, contextDir: program.opts().dir }, cwd: process.cwd(),
            env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(GRAFLY_|GRAFT_)/.test(key))) };
    });
    try { await program.parseAsync(argv, { from: "user" }); }
    catch { return false; }
    if (!request) return false;
    const response = await serviceRequest({ action: "search", ...request });
    if (!response || !Number.isInteger(response.exitCode) || typeof response.stdout !== "string" || typeof response.stderr !== "string") return false;
    process.stdout.write(response.stdout);
    process.stderr.write(response.stderr);
    process.exitCode = response.exitCode;
    return true;
}
