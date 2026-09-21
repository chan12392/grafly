import nodeTest from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

// live.js resolves the MoreCoffee checkout at import (MC_ROOT or an installed
// morecoffee). Without MC the product must fail loudly, but this suite must not:
// skip every test when the adapter cannot be imported.
const live = await import("../dist/session/live.js").catch(() => null);
const { CodexLiveBridge, liveWindow, planLiveCompaction } = live ?? {};
const test = live ? nodeTest : nodeTest.skip;

const native = process.env.GRAFLY_TEST_CODEX;
const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistant = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const tool = (id, body = "OLD_DETAIL_".repeat(1200)) => [
    { type: "function_call", call_id: id, name: "read_file", arguments: '{"path":"local.txt"}' },
    { type: "function_call_output", call_id: id, output: `Exit code: 0\n${body}` },
];
const inputItems = () => [user("Keep PROJECT=orchid and never deploy"), ...tool("old"), assistant("Read complete"), user("Continue")];

test("live plan keeps user constraints, preserves errors, archives eligible old output", () => {
    const items = inputItems();
    items.splice(3, 0, ...tool("failure", "Error: failed read"));
    const plan = planLiveCompaction(items, { keepLast: 2 });
    assert.equal(plan.result.decision.verdict, "compacted");
    assert.deepEqual(plan.items[0], items[0]);
    assert.ok(JSON.stringify(plan.items).includes("Error: failed read"));
    assert.ok(!JSON.stringify(plan.items).includes("OLD_DETAIL_"));
    assert.ok(plan.applied.archives.size > 0);
});

test("live window rejects ambiguous previous compaction, rollback, and wrong identity", () => {
    const raw = [
        { type: "session_meta", payload: { id: "test-thread", history_mode: "paginated" } },
        { type: "response_item", payload: user("host environment") },
        { type: "turn_context", payload: { turn_id: "t1" } },
        ...inputItems().map((payload) => ({ type: "response_item", payload })),
    ].map(JSON.stringify).join("\n");
    assert.equal(liveWindow(raw, "test-thread").prefix.length, 1);
    assert.equal(liveWindow(raw, "test-thread").items.length, 5);
    assert.throws(() => liveWindow(raw, "wrong-thread"), /does not belong/);
    for (const row of [{ type: "compacted", payload: {} }, { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }])
        assert.throws(() => liveWindow(raw + "\n" + JSON.stringify(row), "test-thread"), /replay adapter/);
});

async function fixture(t, historyMode = "paginated", viaCli = false) {
    const dir = mkdtempSync(join(tmpdir(), "grafly-live-test-"));
    const home = join(dir, "home"), cwd = join(dir, "workspace");
    mkdirSync(home); mkdirSync(cwd);
    const requests = [];
    let held = null;
    const server = createServer(async (req, res) => {
        if (req.method !== "POST") { res.end('{"data":[]}'); return; }
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        let buffer = Buffer.concat(chunks);
        if (req.headers["content-encoding"] === "gzip") buffer = gunzipSync(buffer);
        const request = JSON.parse(buffer); requests.push(request);
        const send = () => {
            const content = JSON.stringify(request.input);
            const text = content.includes("PROJECT=orchid") ? "PROJECT=orchid preserved" : "PROJECT missing";
            const item = { id: `msg_${requests.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] };
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const event of [
                { type: "response.created", response: { id: `resp_${requests.length}`, status: "in_progress", output: [] } },
                { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
                { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
                { type: "response.output_item.done", output_index: 0, item },
                { type: "response.completed", response: { id: `resp_${requests.length}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 4, total_tokens: 104 } } },
            ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            res.end();
        };
        if (JSON.stringify(request.input.at(-1)).includes("HOLD_REQUEST")) held = send; else send();
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    writeFileSync(join(home, "config.toml"), `model="gpt-5.1-codex"\nmodel_provider="fixture"\napproval_policy="never"\nsandbox_mode="read-only"\n[model_providers.fixture]\nname="Local fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`);
    const bridge = new CodexLiveBridge({ command: viaCli ? process.execPath : native,
        args: viaCli ? [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "session-live", "--codex", native, "--archive-dir", join(dir, "archives")] : undefined,
        env: { ...process.env, CODEX_HOME: home }, cwd, archiveRoot: join(dir, "archives"), timeoutMs: 10000 });
    let stderr = ""; bridge.on("stderr", (b) => { stderr += b; });
    t.after(async () => { bridge.stop(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
    const methods = [];
    const originalRpc = bridge.rpc.bind(bridge);
    bridge.rpc = (method, params) => { methods.push(method); return originalRpc(method, params); };
    await bridge.request("initialize", { clientInfo: { name: "grafly-live-test", version: "1" }, capabilities: { experimentalApi: true } });
    bridge.send({ method: "initialized" });
    const started = await bridge.request("thread/start", { cwd, historyMode, model: "gpt-5.1-codex", modelProvider: "fixture", approvalPolicy: "never", sandbox: "read-only", baseInstructions: "Local fixture only.", developerInstructions: "Do not execute tools." });
    const threadId = started.thread.id;
    const completion = () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { bridge.off("message", listener); reject(new Error("Turn timeout: " + stderr.slice(-1200))); }, 15000);
        const listener = (m) => {
            if (m.method === "turn/completed" && m.params.threadId === threadId) { clearTimeout(timer); bridge.off("message", listener); resolve(m.params.turn); }
        };
        bridge.on("message", listener);
    });
    const turn = async (text) => {
        const done = completion();
        await bridge.request("turn/start", { threadId, input: [{ type: "text", text }] });
        const result = await done; assert.equal(result.status, "completed", JSON.stringify(result)); return result;
    };
    return { bridge, threadId, turn, completion, requests, methods, release: () => held?.(), dir };
}

for (const historyMode of ["paginated"]) test(`real Codex ${historyMode}: same PID/thread, next request uses MC context`, { skip: !native, timeout: 45000 }, async (t) => {
    const f = await fixture(t, historyMode), { bridge, threadId, requests, methods } = f;
    const pid = bridge.pid;
    await f.turn("Keep PROJECT=orchid and never deploy");
    await bridge.request("thread/inject_items", { threadId, items: tool("old") });
    await f.turn("Inspect baseline context");
    const baseline = JSON.stringify(requests.at(-1).input);
    assert.ok(baseline.includes("OLD_DETAIL_"));
    const result = await bridge.request("thread/mcCompact", { threadId, keepLast: 2 });
    assert.equal(result.status, "applied");
    assert.equal(result.threadId, threadId);
    assert.equal(result.pid, pid);
    assert.equal(bridge.pid, pid);
    assert.equal(result.process_restarted, false);
    assert.ok(existsSync(join(result.archive_directory, "source.jsonl")));
    assert.ok(readFileSync(join(result.archive_directory, "original-items.json"), "utf8").includes("OLD_DETAIL_"));
    await f.turn("Continue using the project and original constraints");
    const after = JSON.stringify(requests.at(-1).input);
    assert.ok(!after.includes("OLD_DETAIL_"));
    assert.ok(after.includes("PROJECT=orchid"));
    assert.ok(after.includes("never deploy"));
    assert.ok(after.includes("MC archived"));
    assert.ok(Buffer.byteLength(after) < Buffer.byteLength(baseline), `${after.length} >= ${baseline.length}`);
    assert.ok(!methods.some((m) => ["thread/resume", "thread/fork", "thread/compact/start"].includes(m)));
    assert.equal(methods.filter((m) => m === "thread/start").length, 1);
    const evidence = { historyMode, pid, threadId, input_bytes_before: Buffer.byteLength(baseline), input_bytes_after: Buffer.byteLength(after), same_process: true, same_thread: true, resume_calls: 0, fork_calls: 0, external_model_calls: 0, provider: "local deterministic fixture; no LLM quality claim", archive_directory: result.archive_directory };
    writeFileSync(join(f.dir, "evidence.json"), JSON.stringify(evidence, null, 2));
    t.diagnostic(JSON.stringify({ ...evidence, evidence: join(f.dir, "evidence.json") }));
    if (historyMode === "paginated") {
        // A second transaction operates on the new canonical branch, not the old
        // rollout. This also checks that previous receipts and user facts survive.
        await bridge.request("thread/inject_items", { threadId, items: tool("second", "SECOND_DETAIL_".repeat(1200)) });
        await f.turn("Inspect second baseline");
        const second = await bridge.request("thread/mcCompact", { threadId, keepLast: 2 });
        assert.equal(second.status, "applied");
        await f.turn("Continue again");
        assert.ok(!JSON.stringify(requests.at(-1).input).includes("SECOND_DETAIL_"));
        assert.ok(JSON.stringify(requests.at(-1).input).includes("PROJECT=orchid"));
    }
});

test("real Codex legacy is rejected before mutation rather than increasing context", { skip: !native, timeout: 45000 }, async (t) => {
    const f = await fixture(t, "legacy");
    await f.turn("Keep PROJECT=orchid");
    await f.bridge.request("thread/inject_items", { threadId: f.threadId, items: tool("old") });
    await f.turn("Baseline");
    await assert.rejects(f.bridge.request("thread/mcCompact", { threadId: f.threadId, keepLast: 2 }), /requires paginated/);
    assert.ok(!f.methods.includes("thread/rollback"));
    assert.ok(!f.methods.includes("thread/revert"));
    await f.turn("Original context still here");
    assert.ok(JSON.stringify(f.requests.at(-1).input).includes("OLD_DETAIL_"));
});

test("real CLI proxy queues the next turn until live replacement finishes", { skip: !native, timeout: 45000 }, async (t) => {
    const f = await fixture(t, "paginated", true);
    await f.turn("Keep PROJECT=orchid and never deploy");
    await f.bridge.request("thread/inject_items", { threadId: f.threadId, items: tool("old") });
    await f.turn("Baseline");
    const done = f.completion();
    // rpc() sends both to the CLI without outer-client serialization. The CLI's
    // owned queue must keep the second request outside the two-step transaction.
    const compact = f.bridge.rpc("thread/mcCompact", { threadId: f.threadId, keepLast: 2 });
    const next = f.bridge.rpc("turn/start", { threadId: f.threadId, input: [{ type: "text", text: "Continue immediately" }] });
    const result = await compact;
    await next; await done;
    assert.equal(result.status, "applied");
    assert.equal(result.threadId, f.threadId);
    assert.ok(!JSON.stringify(f.requests.at(-1).input).includes("OLD_DETAIL_"));
    assert.ok(JSON.stringify(f.requests.at(-1).input).includes("PROJECT=orchid"));
});

test("real Codex rejects active turns and leaves history unchanged", { skip: !native, timeout: 45000 }, async (t) => {
    const f = await fixture(t);
    const done = f.completion();
    await f.bridge.request("turn/start", { threadId: f.threadId, input: [{ type: "text", text: "HOLD_REQUEST PROJECT=orchid" }] });
    await assert.rejects(f.bridge.request("thread/mcCompact", { threadId: f.threadId }), /turn\/completed|idle/);
    // Wait for the held HTTP request to arrive, then complete this owned turn.
    while (!f.requests.length) await new Promise((r) => setTimeout(r, 10));
    f.release(); await done;
    assert.ok(!f.methods.includes("thread/revert"));
    assert.ok(!f.methods.includes("thread/rollback"));
});

test("real Codex failed injection blocks continuation and keeps original backup", { skip: !native, timeout: 45000 }, async (t) => {
    const f = await fixture(t);
    await f.turn("Keep PROJECT=orchid");
    await f.bridge.request("thread/inject_items", { threadId: f.threadId, items: tool("old") });
    await f.turn("Baseline");
    const originalRpc = f.bridge.rpc.bind(f.bridge);
    f.bridge.rpc = (method, params) => method === "thread/inject_items"
        ? Promise.reject(Object.assign(new Error("injected failure"), { rpcError: true, code: -32000 })) : originalRpc(method, params);
    await assert.rejects(f.bridge.request("thread/mcCompact", { threadId: f.threadId, keepLast: 2 }), /injected failure/);
    await assert.rejects(f.bridge.request("turn/start", { threadId: f.threadId, input: [{ type: "text", text: "must not proceed" }] }), /blocked/);
    const dir = f.bridge.blocked.get(f.threadId);
    assert.ok(readFileSync(join(dir, "original-items.json"), "utf8").includes("OLD_DETAIL_"));
    assert.equal(JSON.parse(readFileSync(join(dir, "failed.json"), "utf8")).recovery_required, true);
    f.bridge.blocked.clear(); // Durable journal must block even without the in-memory flag.
    await assert.rejects(f.bridge.request("turn/start", { threadId: f.threadId, input: [] }), /blocked/);
    f.bridge.rpc = originalRpc;
    const original = readFileSync(join(dir, "original-items.json"));
    writeFileSync(join(dir, "original-items.json"), Buffer.concat([original, Buffer.from(" ")]));
    await assert.rejects(f.bridge.request("thread/mcRestore", { threadId: f.threadId }), /integrity/);
    writeFileSync(join(dir, "original-items.json"), original);
    const restored = await f.bridge.request("thread/mcRestore", { threadId: f.threadId });
    assert.equal(restored.status, "restored");
    await f.turn("Check recovered original");
    assert.ok(JSON.stringify(f.requests.at(-1).input).includes("OLD_DETAIL_"));
    assert.ok(JSON.stringify(f.requests.at(-1).input).includes("PROJECT=orchid"));
});

test("real Codex stale history is detected before any reset", { skip: !native, timeout: 45000 }, async (t) => {
    const f = await fixture(t);
    await f.turn("Keep PROJECT=orchid");
    await f.bridge.request("thread/inject_items", { threadId: f.threadId, items: tool("old") });
    await f.turn("Baseline");
    const originalRpc = f.bridge.rpc.bind(f.bridge);
    let reads = 0;
    f.bridge.rpc = async (method, params) => {
        if (method === "thread/read" && ++reads === 2)
            await originalRpc("thread/inject_items", { threadId: f.threadId, items: [user("CONCURRENT_USER_FACT")] });
        return originalRpc(method, params);
    };
    await assert.rejects(f.bridge.request("thread/mcCompact", { threadId: f.threadId, keepLast: 2 }), /changed during preparation/);
    assert.ok(!f.methods.includes("thread/revert"));
    await f.turn("Check unchanged history");
    assert.ok(JSON.stringify(f.requests.at(-1).input).includes("OLD_DETAIL_"));
    assert.ok(JSON.stringify(f.requests.at(-1).input).includes("CONCURRENT_USER_FACT"));
});
