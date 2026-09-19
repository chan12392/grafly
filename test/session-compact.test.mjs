import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeRollout, expandRollout } from "../dist/session/normalize.js";
import { compactRollout, compactFile, expandFile } from "../dist/session/host.js";
import { judgeSessionCompact } from "../dist/session/compact.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const row = (payload) => JSON.stringify({ timestamp: "t", type: "response_item", payload });
const message = (id, role, text) => row({ type: "message", id, role, content: [{ type: "input_text", text }] });
const call = (id, cid, args = "{}", type = "custom_tool_call") => row({ type, id, call_id: cid, name: "read", status: "completed", [type === "function_call" ? "arguments" : "input"]: args });
const output = (id, cid, content, extra = {}) => row({ type: "custom_tool_call_output", id, call_id: cid, output: content, ...extra });
const done = (text) => [{ type: "input_text", text: "Script completed\nWall time 1.0 seconds\nOutput:\n" }, { type: "input_text", text }];
const big = "ordinary source text\n".repeat(300);
const args = JSON.stringify({ query: "한글 😀 long arguments ".repeat(300) });
const fixture = (content = done(big), callArgs = args) => [
    '{ "type": "session_meta", "payload": {"id":"session"} }',
    message("u1", "user", "inspect source"), call("c1", "k1", callArgs),
    message("u2", "user", "preserve this interleaved instruction"),
    '{"type":"event_msg","payload":{"type":"token_count","count":123}}',
    output("o1", "k1", content, { internal_chat_message_metadata_passthrough: { any: "metadata" } }),
    message("tail", "user", "continue"),
].join("\r\n") + "\r\n";
const roundTrip = (raw, options = {}) => {
    const run = compactRollout(raw, { keepLast: 1, ...options });
    assert.equal(run.result.status, "ok");
    const restored = expandRollout(run.compacted, (ref) => run.applied.archives.get(ref), run.applied.manifest);
    assert.equal(restored.lines.join("\n"), raw);
    return run;
};

test("completed batch compacts large call arguments and restores exact interleaved CRLF records", () => {
    const raw = fixture(), run = roundTrip(raw);
    assert.equal(run.result.decision.compacted_batch_count, 1);
    assert.equal(run.result.decision.output_message_count, 4);
    assert.ok(run.compacted.includes("mc_archived_completed_tool_batch"));
    assert.ok(run.compacted.includes("preserve this interleaved instruction"));
    assert.ok(run.compacted.includes('"count":123'));
    const receipt = JSON.parse(run.result.decision.messages.find((m) => m.id === "c1").content);
    assert.deepEqual(JSON.parse(run.applied.archives.get(receipt.archive_ref)).map((m) => m.id), ["c1", "o1"]);
    assert.equal(Array.from(receipt.tools[0].arguments_preview).length, 1024);
    assert.equal(receipt.tools[0].arguments_truncated, true);
    assert.ok(run.result.measurements.exact_restore_verified);
});

test("function-call batch receipt removes obsolete call fields", () => {
    const raw = fixture().replace(call("c1", "k1", args), call("c1", "k1", args, "function_call"));
    const run = roundTrip(raw);
    const receipt = run.compacted.split("\n").filter((l) => l.includes("mc_archived_completed_tool_batch")).map(JSON.parse)[0].payload;
    for (const key of ["arguments", "input", "name", "call_id", "status"]) assert.equal(key in receipt, false, key);
});

test("host rejects a batch receipt whose apparent saving is only archive bookkeeping", () => {
    const raw = [call("c", "k", "x".repeat(300)), output("o", "k", "y".repeat(2000), { isError: false }), message("u", "user", "next")].join("\n");
    const messages = normalizeRollout(raw).messages;
    const body = messages[1].content;
    messages[1].archive = { ref: `${sha(body)}.txt`, sha256: sha(body) };
    const batch = JSON.stringify(messages.slice(0, 2));
    const candidate = judgeSessionCompact({ messages, target_bytes: 100000, keep_last: 1,
        completed_tool_batches: [{ call_message_id: "c", archive: { ref: `${sha(batch)}.json`, sha256: sha(batch) } }] });
    assert.equal(candidate.decision.compacted_batch_count, 1, "exercise an actual channel-selected receipt");
    const run = roundTrip(raw), individual = compactRollout(raw, { keepLast: 1, batches: false });
    assert.equal(run.result.decision.compacted_batch_count, 0);
    assert.equal(run.compacted, individual.compacted);
    assert.equal(run.result.measurements.normalized_output_bytes, individual.result.measurements.normalized_output_bytes);
});

test("missing native IDs get deterministic collision-free host IDs without modifying native IDs", () => {
    const raw = [message("mc_line_2", "user", "reserved"), call(undefined, "k1", args), output(undefined, "k1", done(big)), message(undefined, "user", "continue")].join("\n");
    const a = normalizeRollout(raw), b = normalizeRollout(raw);
    assert.deepEqual(a.messages, b.messages);
    assert.equal(a.messages[1].id, "mc_line_2_");
    assert.equal(new Set(a.messages.map((m) => m.id)).size, 4);
    assert.equal(roundTrip(raw).result.decision.compacted_batch_count, 1);
});

test("multipart text restores part boundaries and unknown fields exactly", () => {
    const run = roundTrip(fixture(done(big), "{}"), { batches: false });
    assert.equal(run.result.decision.compacted_message_count, 1);
    assert.equal(run.result.decision.compacted_batch_count, 0);
});

test("images and unsupported output parts remain in the compacted transcript", () => {
    for (const part of [{ type: "input_image", image_url: "data:image/png;base64,AA==" }, { type: "provider_private", text: "opaque", state: { x: 1 } }]) {
        const raw = fixture([...done(big), part]);
        const run = roundTrip(raw);
        assert.equal(run.result.decision.compacted_message_count, 0);
        assert.equal(run.compacted, raw);
        assert.equal(normalizeRollout(raw).messages.find((m) => m.id === "o1").must_keep, true);
    }
});

test("explicit and nested failure beats a completed call or script wrapper", () => {
    const failures = [
        JSON.stringify({ success: false, error: big }),
        done(JSON.stringify({ isError: true, content: [{ type: "text", text: big }] })),
        done(JSON.stringify({ output: JSON.stringify({ exit_code: 1, output: big }) })),
        done(`Process exited with code 1\n${big}`),
        [{ type: "input_text", text: "Script failed\nWall time 1.0 seconds\nOutput:\n" }, { type: "input_text", text: big }],
    ];
    for (const content of failures) {
        const raw = fixture(content);
        assert.equal(normalizeRollout(raw).messages.find((m) => m.id === "o1").outcome, "error");
        assert.equal(roundTrip(raw).compacted, raw);
    }
});

test("unknown and still-running results are preserved even when the call is completed", () => {
    for (const content of [big, done(JSON.stringify({ session_id: 123, output: big })), done(`Script running with cell ID 12\n${big}`)]) {
        const raw = fixture(content);
        assert.equal(normalizeRollout(raw).messages.find((m) => m.id === "o1").outcome, "unknown");
        assert.equal(roundTrip(raw).compacted, raw);
    }
});

test("pins, caller verification, retention rules and recent results protect complete call pairs", () => {
    for (const options of [{ pin: ["c1"] }, { pin: ["o1"] }, { verify: ["o1"] }, { keepLast: 2 }]) {
        const run = roundTrip(fixture(), options);
        assert.equal(run.result.decision.compacted_message_count, 0);
    }
    assert.equal(roundTrip(fixture(done(big + "\nok=true"))).result.decision.compacted_message_count, 0);
    assert.throws(() => compactRollout(fixture(), { pin: ["missing"] }), { code: "invalid_pin" });
    assert.throws(() => compactRollout(fixture(), { verify: ["tail"] }), { code: "invalid_verification_ids" });
    const tail = roundTrip(fixture(), { pin: ["tail"] });
    assert.equal(tail.result.decision.messages.find((m) => m.id === "tail").must_keep, true);
});

test("individual and batch archive digests are validated before making a decision", () => {
    const messages = normalizeRollout(fixture()).messages;
    messages.find((m) => m.id === "o1").archive = { ref: "wrong.txt", sha256: "0".repeat(64) };
    assert.throws(() => judgeSessionCompact({ messages, target_bytes: 100000 }), { code: "archive_hash_mismatch" });
    delete messages.find((m) => m.id === "o1").archive;
    assert.throws(() => judgeSessionCompact({ messages, target_bytes: 100000, completed_tool_batches: [{ call_message_id: "c1", archive: { ref: "wrong.json", sha256: "0".repeat(64) } }] }), { code: "archive_hash_mismatch" });
    assert.throws(() => judgeSessionCompact({ messages, target_bytes: 100000, completed_tool_batches: {} }), { code: "invalid_batch_archive" });
});

test("malformed rollout, duplicate IDs, unpaired returns and invalid CLI budgets fail closed", () => {
    assert.throws(() => compactRollout(fixture() + "broken"), { code: "invalid_rollout" });
    assert.throws(() => compactRollout(fixture() + message("tail", "user", "duplicate")), { code: "invalid_message_id" });
    assert.throws(() => compactRollout(output("o1", "absent", done(big))), { code: "unpaired_tool_result" });
    for (const value of ["2oops", "1.5", "-1", "1e3", "9007199254740992"]) {
        assert.throws(() => compactRollout(fixture(), { keepLast: value }), { code: "invalid_budget" });
        assert.throws(() => compactRollout(fixture(), { targetBytes: value }), { code: "invalid_budget" });
    }
});

test("missing, corrupt and path-escaping archives never return a partial restore", () => {
    const run = roundTrip(fixture());
    const read = (ref) => run.applied.archives.get(ref);
    assert.throws(() => expandRollout(run.compacted, () => null, run.applied.manifest), { code: "archive_missing" });
    assert.throws(() => expandRollout(run.compacted, () => "corrupted", run.applied.manifest), { code: "archive_hash_mismatch" });
    assert.throws(() => expandRollout(run.compacted + " ", read, run.applied.manifest), { code: "compacted_hash_mismatch" });
    assert.throws(() => expandRollout(run.compacted, read), { code: "missing_restore_manifest" });
    const manifest = structuredClone(run.applied.manifest);
    manifest.archives[0].ref = "../outside.txt";
    let reads = 0;
    assert.throws(() => expandRollout(run.compacted, () => { reads++; }, manifest), { code: "invalid_archive_ref" });
    assert.equal(reads, 0);
});

test("CLI files round-trip byte-for-byte; repeats and restore failures preserve existing files", () => {
    const root = mkdtempSync(join(tmpdir(), "grafly-session-host-")), source = join(root, "source.jsonl");
    const raw = fixture(); writeFileSync(source, raw);
    const compact = compactFile(source, { keepLast: 1 });
    const sourceHash = sha(readFileSync(source));
    const compacted = readFileSync(compact.out);
    assert.throws(() => compactFile(source, { keepLast: 1 }), { code: "output_exists" });
    assert.deepEqual(readFileSync(compact.out), compacted);
    const expanded = expandFile(compact.out);
    assert.deepEqual(readFileSync(expanded.out), readFileSync(source));
    assert.throws(() => expandFile(compact.out), { code: "output_exists" });
    assert.equal(sha(readFileSync(source)), sourceHash);
    const manifest = JSON.parse(readFileSync(compact.manifest, "utf8"));
    writeFileSync(join(compact.archiveDir, manifest.archives[0].ref), "corrupt");
    const newOut = join(root, "must-not-exist.jsonl");
    const cli = join(import.meta.dirname, "..", "dist", "cli.js");
    const failed = spawnSync(process.execPath, [cli, "session-expand", compact.out, "--out", newOut], { encoding: "utf8" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /archive_hash_mismatch/);
    assert.equal(existsSync(newOut), false);
    assert.equal(sha(readFileSync(source)), sourceHash);
});

test("unreachable budget creates no output artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "grafly-session-budget-")), source = join(root, "input.jsonl");
    writeFileSync(source, fixture());
    const result = compactFile(source, { targetBytes: 1 });
    assert.equal(result.status, "abstained");
    assert.equal(existsSync(`${source}.compacted.jsonl`), false);
    assert.equal(existsSync(`${source}.compacted.jsonl.archive`), false);
});
