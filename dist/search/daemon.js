import { connect, createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync, lstatSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";
import { closeIdleEmbedded, embeddedBinding } from "./embedded.js";
import { packageRoot, searchHome, searchEndpoint, searchConfig, serviceRequest, parseResidentRequest, requestEnv } from "./client.js";
import { residentCommands, residentFeatures } from "./commands.js";

export async function serveSearch({ stdio = false } = {}) {
    const home = searchHome(), endpoint = searchEndpoint();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
        // A corrupt/missing discovery file must never let a second process
        // unlink a live Unix socket belonging to the first process.
        const alive = await new Promise((done, fail) => {
            const probe = connect(endpoint);
            probe.once("connect", () => { probe.destroy(); done(true); });
            probe.once("error", (error) => ["ENOENT", "ECONNREFUSED"].includes(error.code) ? done(false) : fail(error));
        });
        if (alive) {
            if (stdio) throw new Error("Grafly is already resident; stop it before opening a stdio session");
            return;
        }
        try {
            if (lstatSync(endpoint).isSocket()) unlinkSync(endpoint);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const token = randomBytes(32).toString("hex");
    let queue = Promise.resolve(), queries = 0, stopping = false, tunnel, retry, activeCommand = null;
    const started = Date.now();
    const { executeSearch } = await import("./request.js");
    const { __parseCount } = await import("../graph/load.js");
    const config = searchConfig();
    // Fail visibly at startup, rather than silently claiming an embedded engine
    // while every query actually falls back to the old JS implementation.
    if (config.xerjUrl === "embedded") embeddedBinding();
    const status = () => ({ status: "running", role: "resident-cli", pid: process.pid, queries,
        uptimeSeconds: Math.floor((Date.now() - started) / 1000), rssMiB: Math.round(process.memoryUsage().rss / 1048576),
        parses: { ...__parseCount }, packageRoot, commands: residentCommands, activeCommand, xerjUrl: config.xerjUrl || null });
    async function execute(request) {
        if (request.action === "status") return status();
        if (request.action === "stop") { stopping = true; return { status: "stopped", pid: process.pid }; }
        if (request.action !== "search" || !residentCommands.includes(request.command) || typeof request.cwd !== "string")
            throw new Error("Use status, stop, or search with command ask|grep|build|callers and cwd");
        if (["build", "callers"].includes(request.command)) {
            const parsed = Array.isArray(request.argv) && request.argv.every((arg) => typeof arg === "string")
                ? await parseResidentRequest(request.argv, request.cwd) : null;
            if (parsed?.command !== request.command) throw new Error("Provide matching build/callers argv");
        } else if (typeof request.query !== "string") throw new Error("Search requires a query");
        const prior = Object.fromEntries(Object.entries(process.env).filter(([key]) => requestEnv.test(key)));
        try {
            activeCommand = request.command;
            // Stdio clients may omit env; executable lookup still belongs to the service.
            for (const key of Object.keys(prior))
                if (!/^(PATH|PATHEXT)$/i.test(key)) delete process.env[key];
            for (const [key, value] of Object.entries(request.env || {}))
                if (requestEnv.test(key) && key.toUpperCase() !== "GRAFLY_SEARCH_HOME" && typeof value === "string") process.env[key] = value;
            // The service owns its endpoint/config independently of client env.
            if (prior.GRAFLY_SEARCH_HOME) process.env.GRAFLY_SEARCH_HOME = prior.GRAFLY_SEARCH_HOME;
            const result = ["build", "callers"].includes(request.command)
                ? await (await import("./cli-request.js")).executeCliRequest(request)
                : await executeSearch(request);
            queries++;
            return result;
        } finally {
            activeCommand = null;
            for (const key of Object.keys(process.env)) if (requestEnv.test(key)) delete process.env[key];
            Object.assign(process.env, prior);
        }
    }
    const server = createServer((socket) => {
        socket.setEncoding("utf8");
        socket.setTimeout(30000, () => socket.destroy());
        socket.on("error", () => {});
        let data = "", received = false;
        socket.on("data", (chunk) => {
            if (received) return;
            data += chunk;
            if (Buffer.byteLength(data) > 1024 * 1024) return socket.destroy();
            const end = data.indexOf("\n");
            if (end < 0) return;
            received = true;
            let request;
            try { request = JSON.parse(data.slice(0, end)); } catch { return socket.destroy(); }
            if (!request || request.token !== token || request.protocol !== 1 || stopping) return socket.destroy();
            // The request is complete. Builds and requests queued behind them
            // may legitimately run longer than the input-idle deadline.
            socket.setTimeout(0);
            // Read-only status must remain available while a build awaits I/O;
            // otherwise clients would mistake a busy service for a stopped one.
            if (request.action === "status") return socket.end(JSON.stringify(status()) + "\n");
            queue = queue.then(async () => {
                if (socket.destroyed) return;
                const result = await execute(request);
                socket.end(JSON.stringify(result) + "\n");
                if (stopping) shutdown();
            }).catch((error) => { console.error(error.message); socket.destroy(); });
        });
    });
    let input;
    // Readers idle for a while are closed so the repositories they map can be moved or deleted.
    const idleReaders = config.xerjUrl === "embedded" ? setInterval(() => closeIdleEmbedded(), 60000) : null;
    idleReaders?.unref();
    function shutdown() {
        stopping = true;
        clearInterval(idleReaders);
        clearTimeout(retry);
        tunnel?.kill();
        input?.close();
        if (stdio) process.stdin.destroy();
        server.close();
    }
    try { await new Promise((done, fail) => { server.once("error", fail); server.listen(endpoint, done); }); }
    catch (error) { if (error.code === "EADDRINUSE" && !stdio) return; throw error; }
    if (process.platform !== "win32") chmodSync(endpoint, 0o600);
    writeFileSync(join(home, "state.json"), JSON.stringify({ protocol: 1, token, pid: process.pid, packageRoot, commands: residentCommands, features: residentFeatures }), { mode: 0o600 });
    server.on("error", (error) => { console.error(error.message); shutdown(); process.exitCode = 1; });
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
    if (config.xerjUrl !== "embedded" && config.oracleHost && config.xerjPort) {
        const log = openSync(join(home, "tunnel.log"), "a");
        const reconnect = () => {
            tunnel = spawn("ssh", ["-N", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes",
                "-o", "ConnectTimeout=10", "-o", "ForwardAgent=no", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
                "-L", `127.0.0.1:${config.xerjPort}:127.0.0.1:${config.xerjPort}`, config.oracleHost],
                { windowsHide: true, stdio: ["ignore", log, log] });
            tunnel.on("error", (error) => console.error("Search tunnel:", error.message));
            tunnel.once("close", () => { if (!stopping) retry = setTimeout(reconnect, 5000); });
        };
        reconnect();
        server.once("close", () => closeSync(log));
    }
    if (stdio) {
        input = createInterface({ input: process.stdin, crlfDelay: Infinity });
        input.on("line", (line) => {
            queue = queue.then(async () => {
                let request;
                try {
                    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("Request exceeds 1 MiB");
                    request = JSON.parse(line);
                    if (!request || typeof request !== "object" || stopping) throw new Error("Invalid request");
                    const result = await execute({ ...request, action: request.action || "search", cwd: request.cwd || process.cwd() });
                    process.stdout.write(JSON.stringify({ id: request.id ?? null, ...result }) + "\n");
                    if (stopping) shutdown();
                } catch (error) {
                    process.stdout.write(JSON.stringify({ id: request?.id ?? null, stdout: "", stderr: error.message + "\n", exitCode: 1 }) + "\n");
                }
            });
        });
        input.on("close", () => { queue = queue.then(shutdown); });
        process.stdout.write(JSON.stringify({ type: "ready", ...status() }) + "\n");
    } else console.log(`Grafly CLI ready: pid=${process.pid}, XERJ=${config.xerjUrl}`);
}

export async function daemonAction(action) {
    if (!["start", "status", "stop", "restart"].includes(action)) throw new Error("Use daemon start|status|stop|restart");
    const status = await serviceRequest({ action: "status" }, 1000);
    if (action === "status") return status || { status: "stopped" };
    if (action === "stop" || action === "restart") {
        if (status) await serviceRequest({ action: "stop" });
        for (let i = 0; i < 40 && await serviceRequest({ action: "status" }, 100); i++) await delay(50);
        if (action === "stop") return { status: "stopped" };
    } else if (status) return status;
    const home = searchHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const entry = fileURLToPath(new URL("../entry.js", import.meta.url));
    if (process.platform === "win32") {
        const quote = (s) => "'" + s.replace(/'/g, "''") + "'";
        const manual = `Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${quote('"' + entry + '" serve')} -WindowStyle Hidden -RedirectStandardOutput ${quote(join(home, "stdout.log"))} -RedirectStandardError ${quote(join(home, "stderr.log"))}`;
        const script = `$task = Get-ScheduledTask -TaskName 'Grafly-Search' -ErrorAction SilentlyContinue; if ($task -and ${quote(home)} -eq ${quote(join(process.env.USERPROFILE, ".grafly", "search-service"))} -and $task.Actions.Arguments.Contains(${quote(entry)})) { if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName 'Grafly-Search' }; Start-ScheduledTask -TaskName 'Grafly-Search' } else { ${manual} }`;
        await new Promise((done, fail) => {
            const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
            let errors = "";
            child.stdout.resume();
            child.stderr.on("data", (chunk) => { errors += chunk; });
            child.on("error", fail);
            child.on("exit", (code) => {
                // Start-Process descendants may inherit pipe handles after the
                // short launcher exits. Do not wait for the resident's lifetime.
                child.stdout.destroy(); child.stderr.destroy();
                code ? fail(new Error(errors)) : done();
            });
        });
    } else {
        const out = openSync(join(home, "stdout.log"), "a"), err = openSync(join(home, "stderr.log"), "a");
        const child = spawn(process.execPath, [entry, "serve"], { detached: true, windowsHide: true, stdio: ["ignore", out, err] });
        child.on("error", (error) => console.error(error.message)); child.unref();
        closeSync(out); closeSync(err);
    }
    for (let i = 0; i < 100; i++) {
        const ready = await serviceRequest({ action: "status" }, 200);
        if (ready) return ready;
        await delay(50);
    }
    throw new Error(`Search service did not start; see ${home}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    serveSearch().catch((error) => { if (error.code !== "EADDRINUSE") { console.error(error.message); process.exitCode = 1; } });
