import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { runCommand, readOutput, applyRanges, isTestCommand, classifyCommand, exitOneMeaning, judge, lines } from "../dist/tool-output/runner.js";
import { searchOutput, writeOutput, readPath } from "../dist/tool-output/output.js";
import { installOutputHook } from "../dist/tool-output/install.js";
import { outputContext } from "../dist/tool-output/hook.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const python = process.env.MC_PYTHON || "python";
/** Probe whether the reachable MC implements a general kind; older/absent MC
 *  yields the documented raw fallback, so kind-dependent tests skip. */
const mcSupports = (kind, env = process.env) => {
    try {
        // Channel accepted the kind (status ok) — verdict itself may be
        // passthrough for probe text with nothing to remove.
        return judge({ stdout: "probe\n".repeat(500), stderr: "", kind, exit_code: 0, complete: true }, env)
            .status === "ok";
    } catch { return false; }
};
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

/** Deterministic stand-in for the MC channel: keeps the first line plus the
 * result tail of stderr, so the reduction path is exercised on hosts without a
 * live morecoffee install. The same reduction contract (ranges, sizes, receipt)
 * is still verified against the real applyRanges/manifest code. */
const stubJudge = (payload) => {
    const source = lines(payload.stderr);
    const tail = source.findIndex(l => /^Ran \d+ tests/.test(l));
    const keep = [[0, 1], [tail < 1 ? source.length : tail, source.length]];
    const kept = keep.flatMap(([a, b]) => source.slice(a, b));
    return { status: "ok", channel_id: "tool_output", reason_codes: ["passing_test_details"],
        decision: { verdict: "reduced", streams: {
            stdout: { keep: [], output_bytes: 0, shown_lines: 0, total_lines: lines(payload.stdout).length },
            stderr: { keep, output_bytes: Buffer.byteLength(kept.join("")), shown_lines: kept.length, total_lines: source.length },
        } } };
};

test("runner executes once, reduces real unittest output, and retrieves exact raw streams", async () => {
    const f = fixture(); const args = suite(f.dir);
    const result = await runCommand(python, args, { ...f.options, judge: stubJudge });
    assert.equal(result.exit_code, 0); assert.equal(result.verdict, "reduced");
    assert.equal(result.mc_attempted, true);
    assert.deepEqual(result.mc_reason_codes, ["passing_test_details"]);
    assert.match(f.text("stderr"), /Ran 160 tests/); assert.match(f.text("stderr"), /grafly tool_output/);
    assert.ok(!f.text("stderr").includes("test_detail_159"));
    const raw = readOutput(result.id, { archiveDir: f.options.archiveDir, stream: "stderr" });
    assert.match(raw.toString(), /test_detail_159/);
    assert.deepEqual(raw, readFileSync(join(result.archive, "stderr.bin")));
    assert.ok(f.data("stderr").length < raw.length / 5);
    const excerpt = readOutput(result.id, { archiveDir: f.options.archiveDir, stream: "stderr", start: 2, count: 1 });
    assert.match(excerpt.toString(), /test_detail_001/);
    const found = searchOutput(result.id, { archiveDir: f.options.archiveDir, find: "test_detail_159", context: 0 });
    assert.match(found, /stderr:160:test_detail_159/);
    assert.ok(Buffer.byteLength(found) < 500);
    writeFileSync(join(result.archive, "stderr.bin"), "tampered");
    assert.throws(() => readOutput(result.id, { archiveDir: f.options.archiveDir, stream: "stderr" }), /integrity/);
    // Where a live MC exists, the real channel still produces the reduction.
    if (mcSupports("test")) {
        const live = fixture(); live.options.cwd = f.dir;
        const real = await runCommand(python, args, live.options);
        assert.equal(real.exit_code, 0); assert.equal(real.verdict, "reduced");
        assert.ok(!live.text("stderr").includes("test_detail_159"));
    }
});

test("rewritten-text streams deliver deduped output; manifest keeps only a size marker", async (t) => {
    if (spawnSync("rg", ["--version"], { encoding: "utf8" }).status !== 0) return t.skip("rg unavailable");
    const f = fixture();
    mkdirSync(join(f.dir, "data"));
    writeFileSync(join(f.dir, "data", "hits.txt"), Array.from({ length: 300 }, (_, i) => `hit ${i}\n`).join(""));
    const raw = spawnSync("rg", ["-n", "hit", "data"], { cwd: f.dir, encoding: "utf8" }).stdout;
    const deduped = "data\\hits.txt\n1:hit 0\n2:hit 1\n";  // representative compressed payload
    const textJudge = () => ({ status: "ok", channel_id: "tool_output", reason_codes: ["search_dedup"],
        decision: { verdict: "reduced", streams: {
            stdout: { text: deduped, output_bytes: Buffer.byteLength(deduped), shown_lines: 2, total_lines: 300, dedup: true },
            stderr: { keep: [], output_bytes: 0, shown_lines: 0, total_lines: 0 } } } });
    const result = await runCommand("rg", ["-n", "hit", "data"], { ...f.options, judge: textJudge });
    assert.equal(result.verdict, "reduced"); assert.equal(result.reason, "search_dedup");
    assert.equal(f.text("stdout"), deduped);
    // Raw archive still holds the original stream byte-for-byte.
    assert.deepEqual(readOutput(result.id, { archiveDir: f.options.archiveDir }).toString(), raw);
    // Manifest audits the decision without duplicating the rewritten payload.
    const manifest = JSON.parse(readFileSync(join(result.archive, "manifest.json"), "utf8"));
    assert.match(manifest.ranges.stdout.text, /^<\d+ chars>$/);
    // A byte-count lie must still fall back to raw.
    const lieJudge = () => ({ status: "ok", channel_id: "tool_output", reason_codes: ["search_dedup"],
        decision: { verdict: "reduced", streams: {
            stdout: { text: deduped, output_bytes: Buffer.byteLength(deduped) + 1 },
            stderr: { keep: [], output_bytes: 0 } } } });
    const f2 = fixture(); f2.options.cwd = f.dir;
    const liar = await runCommand("rg", ["-n", "hit", "data"], { ...f2.options, judge: lieJudge });
    assert.equal(liar.verdict, "passthrough");
    assert.equal(f2.text("stdout"), raw);
});

test("GRAFLY_TOOL_OUTPUT=0 disables archiving and reduction entirely", async () => {
    const f = fixture();
    f.options.env = { ...process.env, GRAFLY_TOOL_OUTPUT: "0" };
    const result = await runCommand(process.execPath, ["-e", "console.log('x'.repeat(9000))"], f.options);
    assert.equal(result.exit_code, 0); assert.equal(result.verdict, "passthrough");
    assert.equal(result.reason, "disabled"); assert.equal(result.archive, null);
    assert.equal(f.data("stdout").length, 9001);
    assert.equal(existsSync(result.id ? join(f.options.archiveDir, result.id) : f.dir), false);
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

test("raw manifests distinguish skipped MC, channel passthrough and insufficient savings", async () => {
    for (const mode of ["unsupported", "small", "failed", "passthrough", "insufficient"]) {
        const f = fixture();
        let calls = 0;
        if (mode === "small") writeFileSync(join(f.dir, "test_small.py"), "import unittest\nclass Small(unittest.TestCase):\n def test_one(self): self.assertEqual(1,1)\n");
        const args = mode === "unsupported" || mode === "failed"
            ? ["-e", "console.log('raw');" + (mode === "failed" ? "process.exit(7)" : "")]
            : mode === "small" ? ["-m", "unittest", "test_small"] : suite(f.dir);
        const command = mode === "unsupported" || mode === "failed" ? process.execPath : python;
        const judge = p => {
            calls++;
            if (mode === "passthrough") return { reason_codes: ["no_supported_reduction"], decision: { verdict: "passthrough" } };
            return { reason_codes: ["passing_test_details"], decision: { verdict: "reduced", streams:
                Object.fromEntries(["stdout", "stderr"].map(s => {
                    const count = (p[s].match(/[^\n]*\n|[^\n]+$/g) ?? []).length;
                    return [s, { keep: count ? [[0, count]] : [], output_bytes: Buffer.byteLength(p[s]) }];
                })) } };
        };
        const result = await runCommand(command, args, { ...f.options, judge });
        const expected = { unsupported: "unsupported_command", small: "output_too_small", failed: "command_failed",
            passthrough: "no_supported_reduction", insufficient: "insufficient_savings" }[mode];
        assert.equal(result.reason, expected, mode);
        assert.equal(result.mc_attempted, mode === "passthrough" || mode === "insufficient");
        assert.equal(calls, Number(result.mc_attempted));
        assert.equal(result.verdict, "passthrough");
        for (const stream of ["stdout", "stderr"]) assert.deepEqual(readOutput(result.id,
            { archiveDir: f.options.archiveDir, stream }), f.data(stream));
        const manifest = JSON.parse(readFileSync(join(result.archive, "manifest.json"), "utf8"));
        assert.equal(manifest.reason, expected);
        if (mode === "insufficient") assert.deepEqual(manifest.mc_reason_codes, ["passing_test_details"]);
    }
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
    assert.equal(result.reason, "archive_unavailable");
});

test("timeout and missing executable cannot report success", async () => {
    const f = fixture();
    const result = await runCommand(process.execPath, ["-e", "setInterval(()=>{},100)"], { ...f.options, timeoutMs: 150 });
    assert.equal(result.exit_code, 124); assert.equal(result.complete, false);
    const missing = await runCommand(join(f.dir, "missing-executable"), [], f.options);
    assert.equal(missing.exit_code, 127); assert.equal(missing.complete, false);
});

test("timeout escalates past SIGTERM-ignoring children and pipe-holding heirs", async (t) => {
    if (process.platform === "win32") return t.skip("group escalation is POSIX-only; win32 uses taskkill /T /F");
    const f = fixture(), started = Date.now();
    // The child ignores SIGTERM; its detached heir survives the group kill and
    // still holds our pipe — the runner must return on SIGKILL + pipe release.
    const result = await runCommand(process.execPath, ["-e",
        "process.on('SIGTERM',()=>{});setInterval(()=>{},50);"
        + "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{detached:true,stdio:'inherit'}).unref()"],
        { ...f.options, timeoutMs: 150 });
    assert.equal(result.exit_code, 124);
    assert.ok(Date.now() - started < 10_000, "escalation must not hang on ignored SIGTERM or held pipes");
});

test("range consumer rejects missing, reordered, duplicate and out-of-bounds evidence", () => {
    for (const keep of [null, [[0, 3]], [[1, 2], [0, 1]], [[0, 1], [0, 1]], [[-1, 1]], [[0, 0]]])
        assert.throws(() => applyRanges("a\nb\n", { keep, output_bytes: 0 }), /invalid/);
});

test("original required and literal focus lines survive, including adjacent retained ranges and CRLF", () => {
    const original = "first\r\nrequired\nfocused 문맥\nlast";
    const stream = keep => ({ keep, output_bytes: Buffer.byteLength(keep.flatMap(([a, b]) => lines(original).slice(a, b)).join('')) });
    const retained = [[1, 2], [2, 4]];
    assert.equal(applyRanges(original, stream(retained), [[1, 4]], ['문맥']), 'required\nfocused 문맥\nlast');
    assert.throws(() => applyRanges(original, stream([[0, 1], [2, 4]]), [[1, 3]]), /required_output_omitted/);
    assert.throws(() => applyRanges(original, stream([[0, 2]]), [], ['문맥']), /focused_output_omitted/);
    assert.throws(() => applyRanges(original, { text: original, output_bytes: Buffer.byteLength(original) }, [], ['문맥']), /original_ranges_required/);
    for (const required of [[[0, 5]], [[-1, 1]], [[1.5, 2]], [[2, 2]], Array(65).fill([0, 1])])
        assert.throws(() => applyRanges(original, stream(retained), required), /invalid_output_hints/);
    assert.throws(() => applyRanges(original, stream(retained), [], ['']), /invalid_output_hints/);
    assert.throws(() => applyRanges(original, stream(retained), [], ['문'.repeat(86)]), /invalid_output_hints/);
});

test("caller ranges and focus reach MC unchanged; an older reduction losing them stays raw and retrievable", async () => {
    const f = fixture(), args = suite(f.dir);
    let payload;
    const result = await runCommand(python, args, { ...f.options, required_stdout_ranges: [],
        required_stderr_ranges: [[100, 101]], focus_terms: ['test_detail_159'],
        judge(input) { payload = input; return stubJudge(input); } });
    assert.deepEqual(payload.required_stdout_ranges, []);
    assert.deepEqual(payload.required_stderr_ranges, [[100, 101]]);
    assert.deepEqual(payload.focus_terms, ['test_detail_159']);
    assert.equal(result.verdict, 'passthrough'); assert.equal(result.reason, 'required_output_omitted');
    assert.equal(f.text('stderr'), payload.stderr);
    assert.equal(readOutput(result.id, { archiveDir: f.options.archiveDir, stream: 'stderr' }).toString(), payload.stderr);
});

test("literal search arguments supply focus only when unambiguous and never rewrite requested coordinates", async t => {
    if (spawnSync('rg', ['--version'], { encoding: 'utf8', windowsHide: true }).status !== 0) return t.skip('rg unavailable');
    const f = fixture();
    writeFileSync(join(f.dir, 'hits.txt'), 'hit -n text repeated\n'.repeat(400));
    for (const [args, expected] of [
        [['-n', '-F', 'hit', 'hits.txt'], ['hit']],
        [['-F', '--', '-n', 'hits.txt'], ['-n']],
        [['-n', 'hit', 'hits.txt'], undefined],
        [['-F', '-i', 'HIT', 'hits.txt'], undefined],
    ]) {
        let actual;
        const result = await runCommand('rg', args, { ...f.options, judge(payload) {
            actual = payload.focus_terms;
            return { decision: { verdict: 'reduced', streams: { stdout: { text: 'changed\n', output_bytes: 8 },
                stderr: { keep: [], output_bytes: 0 } } } };
        } });
        assert.deepEqual(actual, expected);
        if (expected) {
            assert.equal(result.verdict, 'passthrough'); assert.equal(result.reason, 'original_ranges_required');
            assert.match(readOutput(result.id, { archiveDir: f.options.archiveDir }).toString(), /hit -n/);
        }
    }
});

test("source readers and interpreted scripts are not inferred to be tests from output", () => {
    assert.equal(isTestCommand("cat", ["test-results.txt"]), false);
    assert.equal(isTestCommand("node", ["-e", "print('--test')", "--test"]), false);
    assert.equal(isTestCommand("python", ["-c", "pass", "-m", "unittest"]), false);
    assert.equal(isTestCommand("python", ["read_source.py", "-m", "unittest"]), false);
    assert.equal(isTestCommand("node", ["read_source.js", "--test"]), false);
    assert.equal(isTestCommand(python, ["-m", "unittest", "-v"]), true);
});

test("classifyCommand maps exact forms to kinds; wrappers and unknowns stay unclassified", () => {
    assert.equal(classifyCommand("cat", ["f.txt"]), "read");
    assert.equal(classifyCommand("tail.exe", ["-n", "5", "f"]), "read");
    assert.equal(classifyCommand("rg", ["-n", "needle"]), "search");
    assert.equal(classifyCommand("findstr", ["/s", "x", "*.py"]), "search");
    assert.equal(classifyCommand("ls", ["-la"]), "search");
    assert.equal(classifyCommand("git", ["status", "--porcelain"]), "git");
    assert.equal(classifyCommand("git", ["-C", "repo", "diff", "HEAD~1"]), "git");
    assert.equal(classifyCommand("git", ["--git-dir", "x/.git", "--no-pager", "log"]), "git");
    assert.equal(classifyCommand("git", ["-c", "core.pager=cat", "show"]), "git");
    assert.equal(classifyCommand("git", ["grep", "-n", "x"]), "search");
    assert.equal(classifyCommand("git", ["ls-files"]), "search");
    assert.equal(classifyCommand("git", ["show", "HEAD:src/a.py"]), "read");
    assert.equal(classifyCommand("git", ["show", "abc123"]), "git");
    assert.equal(classifyCommand("git", ["diff", "--name-only", "HEAD~1"]), "search");
    assert.equal(classifyCommand("git", ["show", "--stat", "HEAD"]), "search");
    assert.equal(classifyCommand("git", ["log", "--name-only"]), "git");
    assert.equal(classifyCommand("npm", ["install", "--verbose"]), "build");
    assert.equal(classifyCommand("pnpm", ["ci"]), "build");
    assert.equal(classifyCommand("yarn", ["add", "x"]), "build");
    for (const [command, args] of [["powershell", ["-c", "Get-Content", "f"]],
        ["git", ["commit", "-m", "x"]], ["git", ["merge", "b"]], ["git", ["status2"]],
        ["npm", ["run", "build"]], ["python", ["-m", "pip", "install", "x"]],
        ["node", ["script.js"]], ["cmd", ["/c", "dir"]], ["less", ["f"]]])
        assert.equal(classifyCommand(command, args), null, `${command} ${args}`);
    assert.equal(classifyCommand("python", ["-m", "unittest"]), "test");
    assert.equal(classifyCommand("npm", ["test"]), "test");
});

test("exit 1 semantics are command-specific and distinguish diff from no-match", () => {
    for (const command of ["rg", "grep", "egrep", "fgrep", "findstr.exe"])
        assert.equal(exitOneMeaning(command), "no_matches");
    assert.equal(exitOneMeaning("git.exe", ["-C", "repo", "grep", "needle"]), "no_matches");
    assert.equal(exitOneMeaning("git", ["-c", "color.ui=never", "diff", "--quiet"]), "differences");
    for (const command of ["find", "ls", "tree", "node", "powershell", "which", "where"])
        assert.equal(exitOneMeaning(command), null);
    assert.equal(exitOneMeaning("git", ["status"]), null);
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
    assert.match(context.hookSpecificOutput.additionalContext, /output <receipt-id> --find/);
    assert.match(context.hookSpecificOutput.additionalContext, /do not dump entire archives or manifests/);
    assert.equal(context.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(context.hookSpecificOutput.updatedInput, undefined);
    assert.equal(outputContext({ hook_event_name: "PreToolUse" }), null);
});

function archived(stdout, stderr = "") {
    const f = fixture(), id = randomUUID(), dir = join(f.options.archiveDir, id);
    mkdirSync(dir, { recursive: true });
    const streams = {};
    for (const [stream, text] of Object.entries({ stdout, stderr })) {
        const data = Buffer.from(text);
        writeFileSync(join(dir, `${stream}.bin`), data);
        streams[stream] = { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: "grafly.tool-output.v1", id, streams }));
    return { ...f, id, archive: dir, search: options => searchOutput(id, { archiveDir: f.options.archiveDir, ...options }) };
}

test("literal lookup preserves UTF-8 and exact lines across streams, merging overlapping context", () => {
    const f = archived("before\r\n한글 [a.*] exact\r\n[a.*] second\r\nafter\r\n", "[aZZ] ignored\n[a.*] final");
    const result = f.search({ find: "[a.*]" });
    assert.match(result, /stdout: matches=2; shown=2; complete=true/);
    assert.match(result, /stderr: matches=1; shown=1; complete=true/);
    assert.equal((result.match(/stdout:2:한글 \[a\.\*\] exact/g) ?? []).length, 1);
    assert.match(result, /stdout:1:before\n/);
    assert.match(result, /stderr:2:\[a\.\*\] final\n$/);
    const exact = f.search({ find: "한글", context: 0 });
    assert.ok(!exact.includes("stdout:1:"));
    const absent = f.search({ find: "EXACT" });
    assert.equal((absent.match(/matches=0; shown=0; complete=true/g) ?? []).length, 2);
    assert.ok(!absent.includes("stdout:2:"));
});

test("match limits expose continuation without leaking extra matches through context", () => {
    const f = archived("hit one\nhit two\nhit three\n", "hit four\nhit five\n");
    const result = f.search({ find: "hit", maxMatches: 2 });
    assert.match(result, /stdout: matches=3; shown=2; complete=false; next_start=3/);
    assert.match(result, /stderr: matches=2; shown=0; complete=false; next_start=1/);
    assert.ok(!result.includes("hit three"));
    assert.ok(!result.includes("hit four"));
    const next = f.search({ find: "hit", stream: "stdout", start: 3, context: 0 });
    assert.match(next, /matches=1; shown=1; complete=true/);
    assert.match(next, /stdout:3:hit three/);
    assert.ok(!next.includes("hit two"));
});

test("byte limits never split UTF-8; an undeliverable window is a loud error", () => {
    const f = archived("hit " + "한".repeat(4000) + "\n");
    // A window too large for ANY budget the flag allows cannot be paged to —
    // next_start would stall forever, so the search refuses explicitly.
    assert.throws(() => f.search({ find: "hit", context: 0 }), /needs \d+ bytes.*raise --max-bytes/);
    const expanded = f.search({ find: "hit", context: 0, maxBytes: 16384 });
    assert.match(expanded, /shown=1; complete=true/);
    assert.ok(expanded.includes("한".repeat(4000)));
    const many = archived(Array.from({ length: 20 }, (_, i) => `hit ${i} ${"한".repeat(300)}\n`).join(""));
    const bounded = many.search({ find: "hit", context: 0, maxBytes: 2048 });
    assert.ok(Buffer.byteLength(bounded) <= 2048);
    const m = bounded.match(/shown=(\d+); complete=false; next_start=(\d+); limit=bytes/);
    assert.ok(m && Number(m[1]) >= 1 && Number(m[2]) === Number(m[1]) + 1, bounded);
});

test("minimum byte budget still makes progress on an ordinary match", () => {
    const f = archived("needle\n");
    const result = f.search({ find: "needle", maxBytes: 1024 });
    assert.ok(Buffer.byteLength(result) <= 1024);
    assert.match(result, /stdout:1:needle/);
    assert.match(result, /shown=1; complete=true/);
});

test("file read byte budget covers the whole response, header included", () => {
    const f = fixture(), file = join(f.dir, "rows.txt");
    writeFileSync(file, Array.from({ length: 300 }, (_, i) => `row ${i}\n`).join(""));
    const page = readPath(file, { maxBytes: 1024 });
    assert.ok(Buffer.byteLength(page) <= 1024);
    assert.match(page, /complete=false; continue: grafly read <path> --start \d+/);
});

test("search validates ranges and verifies even nonmatching streams before delivering evidence", () => {
    const f = archived("needle\n", "unrelated\n");
    for (const options of [{ find: "" }, { find: "a\nb" }, { find: "needle", count: 1 },
        { find: "needle", context: -1 }, { find: "needle", context: 21 }, { find: "needle", maxMatches: 0 },
        { find: "needle", maxBytes: 10 }, { find: "needle", start: 1.5 }, { find: "needle", stream: "other" }])
        assert.throws(() => f.search(options));
    writeFileSync(join(f.archive, "stderr.bin"), "tampered");
    assert.throws(() => writeOutput(f.id, { archiveDir: f.options.archiveDir, find: "needle" }, f.options), /integrity/);
    assert.equal(f.text("stdout"), "");
    assert.match(f.search({ find: "needle", stream: "stdout" }), /stdout:1:needle/);
    const binary = archived(Buffer.from([255]));
    assert.throws(() => binary.search({ find: "needle" }), /encoded data/);
});

test("public and lightweight CLIs share bounded lookup and preserve raw range compatibility", () => {
    const f = archived("first\nneedle [literal]\nlast\n", "stderr intact\n");
    const entry = fileURLToPath(new URL("../dist/tool-output/cli.js", import.meta.url));
    const options = { encoding: "utf8", env: { ...process.env, GRAFLY_OUTPUT_DIR: f.options.archiveDir } };
    for (const path of [cli, entry]) {
        const result = spawnSync(process.execPath, [path, "output", f.id, "--find", "needle [literal]", "--context", "0"], options);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, f.search({ find: "needle [literal]", context: 0 }));
        assert.equal(result.stderr, "");
        const range = spawnSync(process.execPath, [path, "output", f.id, "--stream", "stdout", "--start", "2", "--count", "1"], options);
        assert.equal(range.status, 0, range.stderr); assert.equal(range.stdout, "needle [literal]\n");
        const full = spawnSync(process.execPath, [path, "output", f.id], options);
        assert.equal(full.status, 0, full.stderr);
        assert.equal(full.stdout, "first\nneedle [literal]\nlast\n"); assert.equal(full.stderr, "stderr intact\n");
        const invalid = spawnSync(process.execPath, [path, "output", f.id, "--context", "0"], options);
        assert.notEqual(invalid.status, 0);
    }
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

test("git status/diff/log reduce bounded while keeping conflict, rename and identity data", async (t) => {
    if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0) return t.skip("git unavailable");
    if (!mcSupports("read")) return t.skip("MC without general kinds (documented raw fallback)");
    const f = fixture(), repo = join(f.dir, "repo");
    const git = args => { const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r; };
    mkdirSync(repo);
    git(["init", "-b", "main"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
    git(["config", "commit.gpgsign", "false"]);
    for (let i = 0; i < 400; i++) writeFileSync(join(repo, `f${String(i).padStart(3, "0")}.py`), `v${i}\n`);
    writeFileSync(join(repo, "conflict.txt"), "base\n"); writeFileSync(join(repo, "old.txt"), "x\n");
    git(["add", "-A"]); git(["commit", "-m", "base"]);
    for (let i = 0; i < 40; i++) git(["commit", "--allow-empty", "-m", `change ${i}`]);
    git(["checkout", "-b", "side"]); writeFileSync(join(repo, "conflict.txt"), "side\n");
    git(["commit", "-am", "side"]); git(["checkout", "main"]);
    writeFileSync(join(repo, "conflict.txt"), "main\n"); git(["commit", "-am", "main"]);
    spawnSync("git", ["merge", "side"], { cwd: repo, encoding: "utf8" }); // conflicts
    git(["mv", "old.txt", "new.txt"]);
    for (let i = 0; i < 400; i++) writeFileSync(join(repo, `f${String(i).padStart(3, "0")}.py`), `v${i} edited\n`);

    const status = await runCommand("git", ["status", "--porcelain"], { ...f.options, cwd: repo });
    assert.equal(status.exit_code, 0); assert.equal(status.verdict, "reduced"); assert.equal(status.kind, "git");
    const shown = f.text("stdout");
    assert.match(shown, /UU conflict\.txt/); assert.match(shown, /R +old\.txt -> new\.txt/);
    assert.ok(!shown.includes("f399.py")); assert.match(f.text("stderr"), /kind=git.*exit=0.*id=/);
    const recovered = searchOutput(status.id, { archiveDir: f.options.archiveDir, find: "f399.py", context: 0 });
    assert.match(recovered, /stdout:\d+: M f399\.py/);

    const f2 = fixture();
    const diff = await runCommand("git", ["diff"], { ...f2.options, cwd: repo });
    assert.equal(diff.verdict, "reduced");
    const dshown = f2.text("stdout");
    assert.match(dshown, /diff --git a\/f000\.py/); assert.match(dshown, /diff --git a\/f399\.py/);
    assert.ok(!dshown.includes("v399 edited")); // late hunks omitted, file identity kept
    const back = readOutput(diff.id, { archiveDir: f2.options.archiveDir }).toString();
    assert.match(back, /v399 edited/); // verbatim original remains retrievable

    const f3 = fixture();
    const log = await runCommand("git", ["log"], { ...f3.options, cwd: repo });
    assert.equal(log.verdict, "reduced");
    assert.match(f3.text("stdout"), /change 39/); assert.match(f3.text("stdout"), /commit [0-9a-f]{40}/);
    assert.ok(!f3.text("stdout").includes("    base\n")); // older messages collapse to ids
}, { timeout: 120000 });

test("rg reduction bounds results, no-match exit 1 is explicit, missing MC stays raw", async (t) => {
    if (spawnSync("rg", ["--version"], { encoding: "utf8" }).status !== 0) return t.skip("rg unavailable");
    const f = fixture(), data = join(f.dir, "data"); // keep archives out of the searched tree
    mkdirSync(data);
    for (let i = 0; i < 300; i++) writeFileSync(join(data, `s${i}.txt`), `needle-${i}\n`);
    if (!mcSupports("read")) {
        const rawOnly = await runCommand("rg", ["needle-", "data"], { ...f.options, cwd: f.dir });
        assert.equal(rawOnly.verdict, "passthrough"); // documented fallback on older MC
        return t.skip("MC without general kinds");
    }
    const result = await runCommand("rg", ["needle-", "data"], { ...f.options, cwd: f.dir });
    assert.equal(result.exit_code, 0); assert.equal(result.verdict, "reduced");
    assert.match(f.text("stderr"), /kind=search.*200\/300 lines/);
    assert.equal((f.text("stdout").match(/needle-/g) ?? []).length, 200);
    assert.match(searchOutput(result.id, { archiveDir: f.options.archiveDir, find: "needle-299", context: 0 }), /s299\.txt.*needle-299/);
    const f2 = fixture();
    const none = await runCommand("rg", ["absent-pattern-xyz", "data"], { ...f2.options, cwd: f.dir });
    assert.equal(none.exit_code, 1);
    assert.match(f2.text("stderr"), /no matches; exit=1/);
    const f3 = fixture(); f3.options.env = { ...process.env, MC_PYTHON: join(f3.dir, "missing-python") };
    const raw = await runCommand("rg", ["needle-", "data"], { ...f3.options, cwd: f.dir });
    assert.equal(raw.verdict, "passthrough"); assert.equal(raw.reason, "mc_unavailable");
    assert.match(f3.text("stdout"), /s299\.txt/);
});

test("npm install-family drops only recognized noise; summaries stay", async (t) => {
    // npm/pnpm/yarn are .cmd shims on Windows — the runner requires a real
    // executable, so the command fails 127 and passes through raw there.
    if (spawnSync("npm", ["--version"], { encoding: "utf8" }).status !== 0) {
        const f = fixture();
        const shim = await runCommand("npm", ["install"], f.options);
        assert.equal(shim.exit_code, 127); assert.equal(shim.verdict, "passthrough");
        assert.match(f.text("stderr"), /grafly run:/);
        return t.skip("npm is not a directly spawnable executable on this host");
    }
    if (!mcSupports("build")) return t.skip("MC without general kinds (documented raw fallback)");
    const f = fixture(), pkg = join(f.dir, "pkg");
    for (let i = 0; i < 30; i++) { const dep = join(pkg, `dep${i}`); mkdirSync(dep, { recursive: true });
        writeFileSync(join(dep, "package.json"), JSON.stringify({ name: `dep${i}`, version: "1.0.0" })); }
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "t", version: "1.0.0",
        dependencies: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`dep${i}`, `file:./dep${i}`])) }));
    const result = await runCommand("npm", ["install", "--loglevel", "silly", "--no-audit", "--no-fund"], { ...f.options, cwd: pkg });
    assert.equal(result.exit_code, 0); assert.equal(result.kind, "build");
    if (result.verdict !== "reduced") return; // under the size floor stays raw
    assert.match(f.text("stderr"), /kind=build.*id=/);
    const shown = f.text("stdout") + f.text("stderr");
    assert.ok(!/npm silly|npm verbose/.test(shown)); // recognized noise removed
    assert.match(shown, /added|up to date/); // summary stays verbatim
    assert.match(readOutput(result.id, { archiveDir: f.options.archiveDir }).toString(), /npm silly/);
}, { timeout: 120000 });

test("unrecognized commands and shell wrappers deliver raw output only", async () => {
    const f = fixture();
    const result = await runCommand(process.execPath, ["-e",
        "for(let i=0;i<500;i++)console.log('row',i)"], f.options);
    assert.equal(result.exit_code, 0); assert.equal(result.verdict, "passthrough");
    assert.equal(result.kind, undefined);
    assert.match(f.text("stdout"), /row 499/); assert.ok(!f.text("stderr").includes("grafly tool_output"));
});

test("read delivers bounded verbatim ranges, literal search and directory listings", () => {
    const f = fixture();
    const spaced = join(f.dir, "sub dir 한글");
    mkdirSync(spaced);
    const file = join(spaced, "log file.txt");
    writeFileSync(file, Array.from({ length: 500 }, (_, i) => `row ${i + 1} ${"한".repeat(3)}\r\n`).join(""));
    const first = readPath(file, {});
    assert.match(first, /shown 1-200; \d+ bytes; complete=false; continue: grafly read <path> --start 201/);
    assert.match(first, /row 200 한한한\r\n$/m);
    assert.ok(!first.includes("row 201"));
    const range = readPath(file, { start: 480, count: 30 });
    assert.match(range, /shown 480-500; \d+ bytes; complete=true/);
    assert.match(range, /row 480/); assert.match(range, /row 500/);
    const found = readPath(file, { find: "row 499", context: 0 });
    assert.match(found, /:499:row 499/); assert.ok(!found.includes("row 498"));
    assert.throws(() => readPath(file, { find: "x", count: 2 }), /--max-matches/);
    const past = readPath(file, { start: 900 });
    assert.match(past, /shown 0; \d+ bytes; complete=true/);
    // Byte budget: whole lines only — a lone oversized line refuses loudly.
    const wide = join(f.dir, "wide.txt");
    writeFileSync(wide, `short\n${"y".repeat(9000)}\nafter\n`);
    const capped = readPath(wide, { maxBytes: 5000 });
    assert.match(capped, /shown 1-1; \d+ bytes; complete=false; continue: grafly read <path> --start 2/);
    assert.ok(capped.includes("short\n")); assert.ok(!capped.includes("yyyy"));
    assert.throws(() => readPath(wide, { start: 2, maxBytes: 5000 }), /line 2 alone is 9001 bytes/);
    const listing = readPath(f.dir, {});
    assert.match(listing, /entries; shown/); assert.match(listing, /sub dir 한글\//);
    mkdirSync(join(f.dir, "empty-dir"));
    assert.match(readPath(join(f.dir, "empty-dir"), {}), /0 entries; shown 0; complete=true/);
    const binary = join(f.dir, "b.bin"); writeFileSync(binary, Buffer.from([0, 255, 1]));
    assert.throws(() => readPath(binary, {}), /encoded data/);
    writeFileSync(binary, Buffer.from([0, 1, 2, 10]));
    assert.throws(() => readPath(binary), /binary file/);
    assert.throws(() => readPath(binary, { find: "x" }), /binary file/);
    assert.throws(() => readPath(join(f.dir, "missing.txt"), {}));
});

test("public and lightweight CLIs share the read entrypoint", () => {
    const f = fixture(), file = join(f.dir, "a.txt");
    writeFileSync(file, "alpha\nbeta needle\ngamma\n");
    const entry = fileURLToPath(new URL("../dist/tool-output/cli.js", import.meta.url));
    for (const path of [cli, entry]) {
        const ranged = spawnSync(process.execPath, [path, "read", file, "--start", "2", "--count", "1"], { encoding: "utf8" });
        assert.equal(ranged.status, 0, ranged.stderr);
        assert.match(ranged.stdout, /3 lines; shown 2-2;/); assert.match(ranged.stdout, /beta needle\n$/);
        const found = spawnSync(process.execPath, [path, "read", file, "--find", "needle", "--context", "0"], { encoding: "utf8" });
        assert.equal(found.status, 0, found.stderr); assert.match(found.stdout, /:2:beta needle/);
        const missing = spawnSync(process.execPath, [path, "read"], { encoding: "utf8" });
        assert.notEqual(missing.status, 0);
    }
});

test("real Git diff retains boundary rename rows and standalone unmerged paths", async (t) => {
    if (!mcSupports("git")) return t.skip("MC without general kinds");
    const f = fixture(), repo = join(f.dir, "repo"); mkdirSync(repo);
    const git = (args, input) => {
        const r = spawnSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: repo, encoding: "utf8", input });
        assert.equal(r.status, 0, r.stderr); return r.stdout;
    };
    git(["init", "-b", "main"]); git(["config", "user.email", "review@example.invalid"]);
    git(["config", "user.name", "Review"]); git(["config", "commit.gpgsign", "false"]);
    for (const name of ["a-prefix.txt", "zz-tail.txt"]) writeFileSync(join(repo, name), "");
    writeFileSync(join(repo, "z-old.txt"), "rename payload\n");
    git(["add", "."]); git(["commit", "-m", "fixture"]);
    writeFileSync(join(repo, "a-prefix.txt"), Array.from({ length: 394 }, (_, i) => `prefix ${i} ${"a".repeat(40)}\n`).join(""));
    writeFileSync(join(repo, "zz-tail.txt"), Array.from({ length: 300 }, (_, i) => `tail ${i} ${"b".repeat(40)}\n`).join(""));
    git(["mv", "z-old.txt", "z-new.txt"]); git(["add", "."]);
    const blob = git(["rev-parse", "HEAD:z-old.txt"]).trim();
    git(["update-index", "--index-info"], [1, 2, 3].map(stage => `100644 ${blob} ${stage}\tzzz-conflict.txt\n`).join(""));
    const raw = git(["diff", "--cached"]);
    assert.equal(raw.split("\n").indexOf("diff --git a/z-old.txt b/z-new.txt"), 399);
    const result = await runCommand("git", ["diff", "--cached", "--exit-code"], { ...f.options, cwd: repo });
    assert.equal(result.exit_code, 1); assert.equal(result.verdict, "reduced");
    for (const line of ["rename from z-old.txt", "rename to z-new.txt", "* Unmerged path zzz-conflict.txt"])
        assert.ok(f.text("stdout").includes(line), line);
    assert.equal(readOutput(result.id, { archiveDir: f.options.archiveDir }).toString(), raw);
    const quiet = fixture();
    const q = await runCommand("git", ["diff", "--cached", "--quiet"], { ...quiet.options, cwd: repo });
    assert.equal(q.exit_code, 1); assert.equal(quiet.text("stdout"), "");
    assert.equal(quiet.text("stderr"), ""); // a difference is not "no matches"
});

test("real find exit-1 failures keep all output and every diagnostic", async (t) => {
    const command = process.platform === "win32" ? "C:/Program Files/Git/usr/bin/find.exe" : "find";
    if (spawnSync(command, ["--version"], { encoding: "utf8" }).status !== 0) return t.skip("GNU find unavailable");
    if (!mcSupports("search")) return t.skip("MC without general kinds");
    const f = fixture(), data = join(f.dir, "data"); mkdirSync(data);
    for (let i = 0; i < 300; i++) writeFileSync(join(data, `f${i}.txt`), "x\n");
    const result = await runCommand(command, ["data", ...Array.from({ length: 240 }, (_, i) => `missing-evidence-path-${i}`)], f.options);
    assert.equal(result.exit_code, 1); assert.equal(result.verdict, "passthrough");
    assert.match(f.text("stderr"), /missing-evidence-path-239/);
    for (const stream of ["stdout", "stderr"])
        assert.deepEqual(f.data(stream), readOutput(result.id, { archiveDir: f.options.archiveDir, stream }));
    assert.ok(!f.text("stderr").includes("no matches"));
});

test("directory byte budget includes metadata and supports exact UTF-8 pagination", () => {
    const f = fixture(), dir = join(f.dir, "directory 한글"); mkdirSync(dir);
    const expected = Array.from({ length: 120 }, (_, i) => `file ${String(i).padStart(3, "0")} 한글.txt`);
    for (const name of expected) writeFileSync(join(dir, name), "x\n");
    const seen = [];
    let start = 1;
    while (true) {
        const page = readPath(dir, { start, maxBytes: 1024 });
        assert.ok(Buffer.byteLength(page) <= 1024);
        seen.push(...page.split("\n").slice(1, -1));
        if (page.includes("complete=true")) break;
        const next = Number(page.match(/continue: grafly read <path> --start (\d+)/)?.[1]);
        assert.ok(next > start); start = next;
    }
    assert.deepEqual(seen, expected);
    assert.match(readPath(dir, { start: 121, maxBytes: 1024 }), /shown 0; complete=true/);
    for (const options of [{ maxBytes: 0 }, { maxBytes: "NaN" }, { context: 0 }, { maxMatches: 2 }])
        assert.throws(() => readPath(dir, options), /invalid max-bytes|search options require/);
    const entry = fileURLToPath(new URL("../dist/tool-output/cli.js", import.meta.url));
    for (const path of [cli, entry]) {
        const result = spawnSync(process.execPath, [path, "read", dir, "--max-bytes", "1024"], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, readPath(dir, { maxBytes: 1024 }));
        for (const args of [["--max-bytes", "0"], ["--context", "0"]]) {
            const bad = spawnSync(process.execPath, [path, "read", dir, ...args], { encoding: "utf8" });
            assert.notEqual(bad.status, 0); assert.equal(bad.stdout, "");
        }
    }
});
