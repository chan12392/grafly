import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPath, serveReadCommand, canServeReadCommand } from "../dist/tool-output/output.js";
import { gateNativeRead } from "../dist/tool-output/conditional.js";
import { acquireLockIn, releaseLockIn } from "../dist/util/state.js";
import { runCommand } from "../dist/tool-output/runner.js";

const fixture = (content, { session = "s1" } = {}) => {
    if (session === null) delete process.env.GRAFLY_SESSION_ID;
    else process.env.GRAFLY_SESSION_ID = session;
    const dir = mkdtempSync(join(tmpdir(), "cond-read-"));
    mkdirSync(join(dir, ".grafly", ".cache"), { recursive: true });
    mkdirSync(join(dir, ".grafly", ".graph"), { recursive: true });
    writeFileSync(join(dir, ".grafly", ".graph", "wiring.json"), "{}");
    const file = join(dir, "file.js");
    writeFileSync(file, content);
    return { dir, file };
};

const body = (n = 100) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n");

test("first read is full; second identical read returns unchanged", () => {
    const { dir, file } = fixture(body());
    const first = readPath(file);
    assert.ok(first.includes("const v0"));
    const second = readPath(file);
    assert.match(second, /unchanged since your previous read/);
    assert.ok(!second.includes("const v0"));
    rmSync(dir, { recursive: true, force: true });
});

test("small edit returns the complete current file", () => {
    const { dir, file } = fixture(body());
    readPath(file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines[50] = "const v50 = 99999;";
    writeFileSync(file, lines.join("\n"));
    const out = readPath(file);
    assert.match(out, /complete=true/);
    assert.ok(out.includes("const v50 = 99999;"));
    assert.ok(out.includes("const v80"), "changed files return all requested content");
    assert.equal(existsSync(join(dir, ".grafly", ".cache", "snaps")), false);
    rmSync(dir, { recursive: true, force: true });
});

test("large edit falls back to full read", () => {
    const { dir, file } = fixture(body());
    readPath(file);
    writeFileSync(file, body().replace(/const v\d+ = \d+;/g, "let changed = true;"));
    const out = readPath(file);
    assert.ok(out.includes("let changed = true;"), "full content returned");
    assert.ok(!out.includes("unchanged since"));
    rmSync(dir, { recursive: true, force: true });
});

test("--fresh bypasses dedup", () => {
    const { dir, file } = fixture(body());
    readPath(file);
    const out = readPath(file, { fresh: true });
    assert.ok(out.includes("const v0"));
    rmSync(dir, { recursive: true, force: true });
});

test("no session stamp means normal reads every time", () => {
    const { dir, file } = fixture(body(), { session: null });
    readPath(file);
    const out = readPath(file);
    assert.ok(out.includes("const v0"));
    rmSync(dir, { recursive: true, force: true });
});

test("different sessions do not share dedup", () => {
    const { dir, file } = fixture(body());
    readPath(file);
    process.env.GRAFLY_SESSION_ID = "s2";
    const out = readPath(file);
    assert.ok(out.includes("const v0"), "new session gets the full file");
    rmSync(dir, { recursive: true, force: true });
});

test("ranged reads are never deduped or recorded", () => {
    const { dir, file } = fixture(body());
    readPath(file, { start: "1", count: "10" }); // partial — must not record
    const out = readPath(file);
    assert.ok(out.includes("const v0"), "full read after partial still full");
    rmSync(dir, { recursive: true, force: true });
});

test("shell read flags consume their values — tail/head/gc forms are serveable", () => {
    const { dir, file } = fixture(body());
    // Flag values must not count as operands: `tail -n 3 f` has one operand.
    for (const [cmd, a] of [["cat", [file]], ["type", [file]], ["tail", ["-n", "3", file]],
        ["tail", ["-n3", file]], ["head", ["-n", "4", file]], ["Get-Content", ["-Tail", "2", file]],
        ["gc", ["-TotalCount", "5", file]], ["more", [file]]])
        assert.ok(canServeReadCommand(cmd, a), `${cmd} ${a}`);
    // Unserveable: extra operand, unknown flag, flag on cat, missing value.
    for (const a of [[file, file], ["-n", file], ["-n"], [file, "-n", "3", file]])
        assert.equal(canServeReadCommand("cat", a) && a.length === 1, false);
    assert.equal(canServeReadCommand("cat", ["-n", file]), false, "cat -n is a real flag — run it");
    assert.equal(canServeReadCommand("tail", ["-n", file]), false, "-n without value");
    const tail = serveReadCommand("tail", ["-n", "2", file], { cwd: dir });
    assert.ok(tail.includes("const v99"), "tail -n 2 returns the last lines");
    assert.ok(!tail.includes("const v0 = 0;"));
    const head = serveReadCommand("head", ["-n", "2", file], { cwd: dir });
    assert.ok(head.includes("const v0 = 0;") && !head.includes("const v99"));
    const gcTail = serveReadCommand("Get-Content", ["-Tail", "1", file], { cwd: dir });
    assert.ok(gcTail.includes("const v99 = 99;") && !gcTail.includes("const v0"));
    rmSync(dir, { recursive: true, force: true });
});

test("served shell reads share the conditional cache", () => {
    const { dir, file } = fixture(body());
    const first = serveReadCommand("cat", [file], { cwd: dir });
    assert.ok(first.includes("const v0"));
    const second = serveReadCommand("type", [file], { cwd: dir });
    assert.match(second, /unchanged since your previous read/);
    rmSync(dir, { recursive: true, force: true });
});

test("a --fresh whole read re-records so repeats dedup against the fresh content", () => {
    const { dir, file } = fixture(body());
    readPath(file);
    writeFileSync(file, body() + "\nconst added = 1;");
    const fresh = readPath(file, { fresh: true });
    assert.ok(fresh.includes("const added"));
    const after = readPath(file);
    assert.match(after, /unchanged since your previous read/, "fresh read updated the record");
    rmSync(dir, { recursive: true, force: true });
});

test("an unindexed ancestor .grafly directory never records file contents or receipts", () => {
    const dir = mkdtempSync(join(tmpdir(), "unindexed-read-"));
    mkdirSync(join(dir, '.grafly'), { recursive: true });
    const nested = join(dir, 'workspace'); mkdirSync(nested);
    const file = join(nested, '.env'); writeFileSync(file, 'SECRET=fixture-only');
    for (let i = 0; i < 2; i++) {
        assert.match(readPath(file, { sessionId: 'outside' }), /SECRET=fixture-only/);
        assert.deepEqual(gateNativeRead(file, { sessionId: 'outside' }), { deny: false });
    }
    assert.equal(existsSync(join(dir, '.grafly', '.cache')), false);
    rmSync(dir, { recursive: true, force: true });
});

test("60KB native partial reads never establish whole-file context", () => {
    const { dir, file } = fixture(('x'.repeat(199) + '\n').repeat(300));
    for (let i = 0; i < 2; i++)
        assert.deepEqual(gateNativeRead(file, { sessionId: 'devin:partial' }), { deny: false });
    assert.doesNotMatch(serveReadCommand('cat', [file], { sessionId: 'devin:partial' }), /unchanged/);
    assert.doesNotMatch(readPath(file, { sessionId: 'devin:partial' }), /unchanged/);
    assert.doesNotMatch(readPath(file, { start: 250, count: 51, sessionId: 'devin:partial' }), /unchanged/);
    // Even after Grafly delivered it all, the native size guard still passes.
    readPath(file, { count: 400, sessionId: 'devin:partial' });
    assert.deepEqual(gateNativeRead(file, { sessionId: 'devin:partial' }), { deny: false });
    rmSync(dir, { recursive: true, force: true });
});

test("read receipts expire, stay bounded, and preserve state under lock contention", () => {
    const { dir, file } = fixture(body(1));
    const cache = join(dir, '.grafly', '.cache'), path = join(cache, 'session-reads.json');
    const now = Date.now(), hash = 'stale';
    const sessions = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, {
        ts: now - i, files: { [file]: { hash, ts: now - i } },
    }]));
    sessions.expired = { ts: now - 86400001, files: { [file]: { hash, ts: now - 86400001 } } };
    writeFileSync(path, JSON.stringify({ version: 2, sessions }));
    readPath(file, { sessionId: 'new' });
    let saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(Object.keys(saved.sessions).length, 32);
    assert.equal(saved.sessions.expired, undefined);
    assert.ok(saved.sessions.new);
    for (let i = 0; i < 65; i++) {
        const p = join(dir, `file${i}.txt`); writeFileSync(p, String(i));
        readPath(p, { sessionId: 'new' });
    }
    saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(Object.keys(saved.sessions.new.files).length, 60);
    assert.equal(saved.sessions.new.files[file], undefined);
    const before = readFileSync(path, 'utf8');
    const lock = join(cache, 'read-state');
    assert.equal(acquireLockIn(lock), true);
    try {
        assert.match(readPath(file, { sessionId: 'blocked' }), /const v0/);
        assert.deepEqual(gateNativeRead(file, { sessionId: 'new' }), { deny: false });
        assert.equal(readFileSync(path, 'utf8'), before);
    } finally { releaseLockIn(lock); }
    // Old pre-tool records and corrupt JSON cannot suppress a read.
    writeFileSync(path, JSON.stringify({ old: { [file]: { hash } } }));
    assert.match(readPath(file, { sessionId: 'old' }), /const v0/);
    writeFileSync(path, '{bad');
    assert.match(readPath(file, { sessionId: 'old' }), /const v0/);
    rmSync(dir, { recursive: true, force: true });
});

test("more with multiple files runs the executable", async () => {
    const { dir, file } = fixture('first\n');
    const second = join(dir, 'second.txt'); writeFileSync(second, 'second\n');
    let stdout = '', stderr = '';
    const command = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32', 'more.com') : 'more';
    const result = await runCommand(command, [file, second], { cwd: dir, timeoutMs: 2000,
        archiveDir: join(dir, 'archives'), stdout: { write: s => { stdout += s; } },
        stderr: { write: s => { stderr += s; } } });
    // Windows more waits for a key between files even with redirected stdout.
    // A timeout proves it reached the pager; the old builtin guard exited 1.
    assert.equal(result.exit_code, process.platform === 'win32' ? 124 : 0, stderr);
    assert.match(stdout, /first/);
    if (process.platform !== 'win32') assert.match(stdout, /second/);
    assert.ok(result.archive, 'the real process produced an output archive');
    assert.doesNotMatch(stderr, /shell builtin/);
    rmSync(dir, { recursive: true, force: true });
});

test("range parser rejects malformed and duplicate flags", () => {
    for (const flags of [['-n=5'], ['-n0'], ['-n2', '-n3'], ['-n', '2', '-n3']])
        assert.equal(canServeReadCommand('head', [...flags, 'file.txt']), false);
});
