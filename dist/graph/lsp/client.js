/**
 * A minimal LSP client for the opt-in `--lsp` enrichment pass — just enough to
 * pull compiler-grade call edges out of a language server: spawn it over stdio,
 * initialize, open documents, and run the call-hierarchy requests. Built on
 * `vscode-jsonrpc` (we don't hand-roll the framing). Everything is best-effort:
 * a server that is missing, slow, or errors degrades to "no enrichment", never a
 * crash — the AST graph stands on its own.
 */
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, } from "vscode-jsonrpc/node.js";
const uriOf = (abs) => pathToFileURL(abs).toString();
export class LspClient {
    root;
    languageId;
    callTimeoutMs;
    proc;
    conn;
    opened = new Set();
    ready = false;
    spawnFailed = false;
    constructor(command, args, root, languageId, callTimeoutMs = 15000) {
        this.root = root;
        this.languageId = languageId;
        this.callTimeoutMs = callTimeoutMs;
        this.proc = spawn(command, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
        // ENOENT (bad path) OR an immediate exit (e.g. a rustup shim whose component
        // isn't installed) must fail fast, not hang a request for the full timeout.
        this.proc.on("error", () => { this.spawnFailed = true; });
        // An immediate exit (shim without its component, crash on startup) must fail
        // fast so initialize bails instead of waiting out the timeout; once we've
        // marked !ready, in-flight queries no-op. Firing during dispose is harmless.
        this.proc.on("exit", () => { this.spawnFailed = true; this.ready = false; });
        this.proc.stderr.resume(); // drain; servers are chatty on stderr
        // Swallow write-after-destroy (EPIPE / ERR_STREAM_DESTROYED) when the server
        // closes its stdin during/after shutdown — otherwise it surfaces as an
        // unhandled stream error and taints the process exit code.
        this.proc.stdin.on("error", () => { });
        this.conn = createMessageConnection(new StreamMessageReader(this.proc.stdout), new StreamMessageWriter(this.proc.stdin));
        // Answer the reverse-RPC requests every server makes during startup so it
        // doesn't block waiting on us; we take defaults for all of them.
        this.conn.onRequest("workspace/configuration", (p) => (p.items ?? []).map(() => ({})));
        this.conn.onRequest("client/registerCapability", () => null);
        this.conn.onRequest("window/workDoneProgress/create", () => null);
        this.conn.onRequest("workspace/applyEdit", () => ({ applied: false }));
        this.conn.onNotification(() => { }); // swallow all notifications (diagnostics, progress, logs)
        // The connection/streams can error or close asynchronously (server exits,
        // stdin destroyed) — absorb both so a late write never becomes an unhandled
        // exception that taints the build's exit code.
        this.conn.onError(() => { this.ready = false; });
        this.conn.onClose(() => { this.ready = false; });
        this.conn.listen();
    }
    /** Safe to write to the server's stdin right now? */
    canWrite() {
        return this.ready && this.proc.stdin.writable && !this.proc.stdin.destroyed;
    }
    /** A request with a timeout so a wedged server can't hang the whole build. */
    call(method, params) {
        if (!this.canWrite())
            return Promise.resolve(null);
        return new Promise((resolve) => {
            let done = false;
            const t = setTimeout(() => { if (!done) {
                done = true;
                resolve(null);
            } }, this.callTimeoutMs);
            this.conn.sendRequest(method, params).then((r) => { if (!done) {
                done = true;
                clearTimeout(t);
                resolve(r);
            } }, () => { if (!done) {
                done = true;
                clearTimeout(t);
                resolve(null);
            } });
        });
    }
    async initialize() {
        // Let a synchronous spawn failure (ENOENT) surface before we wait on a
        // response that will never come.
        await new Promise((r) => setTimeout(r, 50));
        if (this.spawnFailed || this.proc.pid === undefined)
            return false;
        const rootUri = uriOf(this.root);
        // Cold-workspace load (rust-analyzer/clangd index the project) can take a
        // while — give initialize a generous timeout, separate from per-request.
        const init = await new Promise((resolve) => {
            const t = setTimeout(() => resolve(null), 120000);
            this.conn.sendRequest("initialize", {
                processId: process.pid,
                rootUri,
                workspaceFolders: [{ uri: rootUri, name: "root" }],
                capabilities: {
                    textDocument: {
                        callHierarchy: { dynamicRegistration: false },
                        synchronization: { dynamicRegistration: false },
                    },
                    workspace: { workspaceFolders: true, configuration: true },
                },
            }).then((r) => { clearTimeout(t); resolve(r); }, () => { clearTimeout(t); resolve(null); });
        });
        if (!init)
            return false;
        this.conn.sendNotification("initialized", {});
        this.ready = true;
        return true;
    }
    /** Open a document (idempotent). Servers resolve cross-file refs from disk, but
     * the LSP spec wants the queried document opened first. */
    didOpen(abs) {
        if (!this.canWrite() || this.opened.has(abs))
            return;
        let text = "";
        try {
            text = readFileSync(abs, "utf8");
        }
        catch {
            return;
        }
        this.opened.add(abs);
        try {
            this.conn.sendNotification("textDocument/didOpen", {
                textDocument: { uri: uriOf(abs), languageId: this.languageId, version: 1, text },
            });
        }
        catch { /* stream closed mid-write */ }
    }
    /** Poll one probe position until call-hierarchy returns something — servers
     * like rust-analyzer/clangd index AFTER `initialized` and answer empty until
     * ready. Returns true once ready (or false at the cap). */
    async waitUntilReady(abs, pos, maxMs = 90000) {
        this.didOpen(abs);
        const deadline = Date.now() + maxMs;
        while (Date.now() < deadline) {
            const items = await this.prepareCallHierarchy(abs, pos);
            if (items.length)
                return true;
            await new Promise((r) => setTimeout(r, 2000));
        }
        return false;
    }
    async prepareCallHierarchy(abs, pos) {
        if (!this.ready)
            return [];
        const r = await this.call("textDocument/prepareCallHierarchy", {
            textDocument: { uri: uriOf(abs) },
            position: pos,
        });
        return r ?? [];
    }
    /** The callees of an item — returns each outgoing call's `to` target. */
    async outgoingCalls(item) {
        if (!this.ready)
            return [];
        const r = await this.call("callHierarchy/outgoingCalls", { item });
        return (r ?? []).map((c) => c.to).filter(Boolean);
    }
    async dispose() {
        // Skip the graceful LSP shutdown/exit handshake: writing `exit` to a server
        // that has already closed its stdin throws ERR_STREAM_DESTROYED and taints
        // the exit code. The graph is already built; just tear the process down.
        this.ready = false;
        try {
            this.conn.dispose();
        }
        catch { /* ignore */ }
        try {
            this.proc.stdin.destroy();
        }
        catch { /* ignore */ }
        try {
            this.proc.kill("SIGKILL");
        }
        catch { /* ignore */ }
    }
}
//# sourceMappingURL=client.js.map