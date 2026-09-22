import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCommand, readOutput, applyRanges, isTestCommand } from "../dist/tool-output/runner.js";
import { installOutputHook } from "../dist/tool-output/install.js";
import { outputContext } from "../dist/tool-output/hook.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const python = process.env.MC_PYTHON || "python";
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "grafly-output-")), archiveDir = join(dir, "archive");
    const collected = { stdout: [], stderr: [] };
    const options = { cwd: dir, archiveDir,
        stdout: { write: b => collected.stdout.push(Buffer.from(b)) }, stderr: { write: b => collected.stderr.push(Buffer.from(b)) } };
    return { dir, options, collected, text: name => Buffer.concat(collected[name]).toString("utf8"), data: name => Buffer.concat(collected[name]) };
}
function suite(dir) {
    writeFileSync(join(dir, "test_output_sample.py"), "import unittest\nclass Sample(unittest.TestCase):\n    pass\nfor i in range(160):\n    setattr(Sample, f'test_detail_{i:03}', lambda self: self.assertEqual(1, 1))\n");
    return ["-m", "unittest", "-v", "test_output_sample"];
}

test("runner executes once, reduces real unittest output, and retrieves exact raw streams", async () => {
    const f = fixture(); const args = suite(f.dir);
    const result = await runCommand(python, args, f.options);
    assert.equal(result.exit_code, 0); assert.equal(result.verdict, "reduced");
    assert.match(f.text("stderr"), /Ran 160 tests/); assert.match(f.text("stderr"), /grafly tool_output/);
    assert.ok(!f.text("stderr").includes("test_detail_159"));
    const raw = readOutput(result.id, { archiveDir: f.options.archiveDir, stream: "stderr" });
    assert.match(raw.toString(), /test_detail_159/);
    assert.deepEqual(raw, readFileSync(join(result.archive, "stderr.bin")));
    assert.ok(f.data("stderr").length < raw.length / 5);
    const excerpt = readOutput(result.id, { archiveDir: f.options.archiveDir, stream: "stderr", start: 2, count: 1 });
    assert.match(excerpt.toString(), /test_detail_001/);
    writeFileSync(join(result.archive, "stderr.bin"), "tampered");
    assert.throws(() => readOutput(result.id, { archiveDir: f.options.archiveDir, stream: "stderr" }), /integrity/);
});

test("failure exit, UTF-8, stderr and literal shell metacharacters survive unchanged", async () => {
    const f = fixture(), value = "한글 `x` $HOME $(oops) ' \" ; & |";
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write(process.argv[1]);process.stderr.write('failure details\\n');process.exit(7)", value], f.options);
    assert.equal(result.exit_code, 7); assert.equal(result.verdict, "passthrough");
    assert.equal(f.text("stdout"), value); assert.equal(f.text("stderr"), "failure details\n");
    assert.equal(readOutput(result.id, { archiveDir: f.options.archiveDir }).toString(), value);
});

test("missing MC leaves complete output intact with no repeated command", async () => {
    const f = fixture(); const args = suite(f.dir);
    f.options.env = { ...process.env, MC_PYTHON: join(f.dir, "missing-python") };
    const result = await runCommand(python, args, f.options);
    assert.equal(result.exit_code, 0); assert.equal(result.reason, "mc_unavailable");
    assert.match(f.text("stderr"), /test_detail_159/);
    assert.equal((f.text("stderr").match(/Ran 160 tests/g) ?? []).length, 1);
});

test("short and unknown output never starts MC; binary and oversized output are exact", async () => {
    for (const size of [12, 9000, 4 * 1024 * 1024 + 123]) {
        const f = fixture(); f.options.env = { ...process.env, MC_PYTHON: "nonexistent" };
        const result = await runCommand(process.execPath, ["-e", `process.stdout.write(Buffer.alloc(${size},255))`], f.options);
        assert.equal(result.exit_code, 0); assert.equal(f.data("stdout").length, size);
        assert.deepEqual(f.data("stdout"), Buffer.alloc(size, 255));
        assert.notEqual(result.reason, "mc_unavailable");
        assert.deepEqual(readOutput(result.id, { archiveDir: f.options.archiveDir }), f.data("stdout"));
    }
});

test("archive failure runs command once and delivers its output without reducing", async () => {
    const f = fixture(); writeFileSync(f.options.archiveDir, "not a directory");
    const result = await runCommand(process.execPath, ["-e", "console.log('once')"], f.options);
    assert.equal(result.archive, null); assert.equal(result.exit_code, 0); assert.equal(f.text("stdout"), "once\n");
});

test("timeout and missing executable cannot report success", async () => {
    const f = fixture();
    const result = await runCommand(process.execPath, ["-e", "setInterval(()=>{},100)"], { ...f.options, timeoutMs: 150 });
    assert.equal(result.exit_code, 124); assert.equal(result.complete, false);
    const missing = await runCommand(join(f.dir, "missing-executable"), [], f.options);
    assert.equal(missing.exit_code, 127); assert.equal(missing.complete, false);
});

test("range consumer rejects missing, reordered, duplicate and out-of-bounds evidence", () => {
    for (const keep of [null, [[0, 3]], [[1, 2], [0, 1]], [[0, 1], [0, 1]], [[-1, 1]], [[0, 0]]])
        assert.throws(() => applyRanges("a\nb\n", { keep, output_bytes: 0 }), /invalid/);
});

test("source readers and interpreted scripts are not inferred to be tests from output", () => {
    assert.equal(isTestCommand("cat", ["test-results.txt"]), false);
    assert.equal(isTestCommand("node", ["-e", "print('--test')", "--test"]), false);
    assert.equal(isTestCommand("python", ["-c", "pass", "-m", "unittest"]), false);
    assert.equal(isTestCommand("python", ["read_source.py", "-m", "unittest"]), false);
    assert.equal(isTestCommand("node", ["read_source.js", "--test"]), false);
    assert.equal(isTestCommand(python, ["-m", "unittest", "-v"]), true);
});

test("host installer preserves foreign hooks and their identities, is idempotent and reversible", () => {
    const f = fixture(), home = join(f.dir, "home"); mkdirSync(home);
    const original = { other: "keep", hooks: { PreToolUse: [{ hooks: [{ command: "security", timeout: 10 }] }], SessionStart: [{ hooks: [{ command: "existing", timeout: 10 }] }] } };
    const path = join(home, "hooks.json"); writeFileSync(path, JSON.stringify(original));
    const result = installOutputHook(home);
    assert.ok(existsSync(result.backup)); assert.deepEqual(JSON.parse(readFileSync(result.backup)), original);
    const installed = JSON.parse(readFileSync(path));
    assert.deepEqual(installed.hooks.PreToolUse, original.hooks.PreToolUse);
    assert.deepEqual(installed.hooks.SessionStart[0], original.hooks.SessionStart[0]);
    assert.equal(installOutputHook(home).action, "unchanged");
    installOutputHook(home, { remove: true });
    const removed = JSON.parse(readFileSync(path));
    assert.deepEqual(removed.hooks.PreToolUse, original.hooks.PreToolUse);
    assert.deepEqual(removed.hooks.SessionStart, original.hooks.SessionStart);
    writeFileSync(path, "broken JSON"); assert.throws(() => installOutputHook(home));
    assert.equal(readFileSync(path, "utf8"), "broken JSON");
});

test("host context routes nested exec tools without rewriting input or granting permissions", () => {
    const context = outputContext({ hook_event_name: "UserPromptSubmit" });
    assert.match(context.hookSpecificOutput.additionalContext, /tools.exec_command inside functions.exec/);
    assert.equal(context.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(context.hookSpecificOutput.updatedInput, undefined);
    assert.equal(outputContext({ hook_event_name: "PreToolUse" }), null);
});

test("public CLI preserves exit code and removed session commands are unavailable", () => {
    const f = fixture();
    const result = spawnSync(process.execPath, [cli, "run", "--", process.execPath, "-e", "process.exit(23)"], { env: { ...process.env, GRAFLY_OUTPUT_DIR: f.options.archiveDir }, encoding: "utf8" });
    assert.equal(result.status, 23, result.stderr);
    for (const name of ["session-compact", "session-expand", "session-live"]) {
        const retired = spawnSync(process.execPath, [cli, name], { encoding: "utf8" });
        assert.notEqual(retired.status, 0); assert.match(retired.stderr, /unknown command/);
    }
});
