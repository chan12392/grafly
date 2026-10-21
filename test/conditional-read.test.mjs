import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPath, serveReadCommand, canServeReadCommand } from "../dist/tool-output/output.js";

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
    for (const value of ["+3", "-3", "0x3", "3e1"]) {
        assert.equal(canServeReadCommand("tail", ["-n", value, file]), false, value);
        assert.equal(serveReadCommand("tail", ["-n", value, file], { cwd: dir }), null, value);
    }
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
