/** Opt-in real Codex test with a loopback-only mock Responses endpoint. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";


const native = process.env.GRAFLY_TEST_CODEX;
function client(home, cwd, archive) {
    const child = spawn(native, ["app-server", "--listen", "stdio://"], { cwd, windowsHide: true,
        env: { ...process.env, CODEX_HOME: home, GRAFLY_OUTPUT_DIR: archive }, stdio: ["pipe", "pipe", "pipe"] });
    let sequence = 0, errors = "";
    const pending = new Map(), messages = [];
    child.stderr.on("data", b => { errors += b; });
    createInterface({ input: child.stdout }).on("line", line => {
        const msg = JSON.parse(line); messages.push(msg);
        if (pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
    });
    const request = (method, params) => new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => reject(new Error(`${method} timeout ${errors.slice(-500)}`)), 15000);
        pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
    return { child, messages, request, errors: () => errors, stop: () => child.stdin.end(),
        init: async () => { await request("initialize", { clientInfo: { name: "grafly-output-test", version: "1" }, capabilities: { experimentalApi: true } }); child.stdin.write('{"method":"initialized"}\n'); } };
}

test("native Codex rewrites an unwrapped command before output reaches the model", { skip: !native, timeout: 50000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), "grafly-output-native-"));
    const home = join(dir, "home"), cwd = join(dir, "workspace"), archive = join(dir, "archive");
    mkdirSync(home); mkdirSync(cwd);
    writeFileSync(join(cwd, "test_sample.py"), "import unittest\nclass Samples(unittest.TestCase):\n    pass\nfor i in range(180):\n    setattr(Samples, f'test_detail_{i:03}', lambda self: self.assertEqual(1, 1))\n");
    const requests = [];
    const server = createServer(async (req, res) => {
        if (req.method !== "POST") { res.end('{"data":[]}'); return; }
        const chunks = []; for await (const b of req) chunks.push(b);
        let raw = Buffer.concat(chunks); if (req.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
        const request = JSON.parse(raw); requests.push(request);
        writeFileSync(join(dir, `request-${requests.length}.json`), JSON.stringify(request, null, 2));
        const entry = fileURLToPath(new URL("../dist/tool-output/cli.js", import.meta.url));
        const cmd = "python -m unittest -v test_sample";
        const item = requests.length === 1
            ? { id: "fc_1", type: "function_call", call_id: "call_test", name: "exec_command", arguments: JSON.stringify({ cmd, workdir: cwd, max_output_tokens: 10000 }) }
            : { id: "msg_2", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done" }] };
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
            { type: "response.created", response: { id: `r${requests.length}`, status: "in_progress", output: [] } },
            { type: "response.output_item.added", output_index: 0, item },
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response: { id: `r${requests.length}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
        ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(() => { server.closeAllConnections(); server.close(); });
    const config = join(home, "config.toml");
    writeFileSync(config, `model="gpt-5.1-codex"\nmodel_provider="fixture"\napproval_policy="never"\nsandbox_mode="danger-full-access"\n[model_providers.fixture]\nname="Local test"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`);
    writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "& '" + process.execPath + "' '" + fileURLToPath(new URL("../dist/tool-output/route-hook.js", import.meta.url)) + "' codex", timeout: 5 }] }] } }));
    // Review this test's exact installed hook via native metadata, then record
    // trust in its disposable home. No user's hook state is touched by tests.
    const inspection = client(home, cwd, archive); await inspection.init();
    const listed = await inspection.request("hooks/list", { cwds: [cwd] });
    for (const hook of listed.data.flatMap(row => row.hooks))
        appendFileSync(config, `\n[hooks.state.${JSON.stringify(hook.key)}]\ntrusted_hash=${JSON.stringify(hook.currentHash)}\n`);
    inspection.stop(); await once(inspection.child, "exit");
    const host = client(home, cwd, archive); t.after(() => host.child.kill()); await host.init();
    const started = await host.request("thread/start", { cwd, model: "gpt-5.1-codex", modelProvider: "fixture", approvalPolicy: "never", sandbox: "danger-full-access", baseInstructions: "Local fixture.", developerInstructions: "Run the requested test." });
    await host.request("turn/start", { threadId: started.thread.id, input: [{ type: "text", text: "Run the local test." }] });
    const deadline = Date.now() + 25000;
    while (!host.messages.some(m => m.method === "turn/completed") && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    writeFileSync(join(dir, "events.json"), JSON.stringify(host.messages, null, 2));
    t.diagnostic(`native evidence: ${dir}`);
    assert.ok(requests.length >= 2, host.errors());

    const output = JSON.stringify(requests.at(-1).input.filter(item => item.type.endsWith("output")));
    assert.match(output, /Ran 180 tests/);
    assert.match(output, /grafly tool_output/);
    assert.ok(!output.includes("test_detail_179"), output.slice(-1500));
    const ids = readdirSync(archive);
    assert.equal(ids.length, 1, "unwrapped model command must enter Grafly exactly once");
    assert.match(readFileSync(join(archive, ids[0], "stderr.bin"), "utf8"), /test_detail_179/);
    assert.equal(JSON.parse(readFileSync(join(archive, ids[0], "manifest.json"))).exit_code, 0);
    host.stop();
});
