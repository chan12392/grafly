import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPath } from "../dist/tool-output/output.js";

const fixture = (content, { session = "s1" } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "cond-read-"));
    mkdirSync(join(dir, ".grafly", ".cache"), { recursive: true });
    if (session !== null) writeFileSync(join(dir, ".grafly", ".cache", "active-session"), session);
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

test("small edit replays only the changed hunk", () => {
    const { dir, file } = fixture(body());
    readPath(file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines[50] = "const v50 = 99999;";
    writeFileSync(file, lines.join("\n"));
    const out = readPath(file);
    assert.match(out, /changed since @[0-9a-f]+ → @[0-9a-f]+/);
    assert.ok(out.includes("51: const v50 = 99999;"));
    assert.ok(!out.includes("const v80"), "unchanged regions must be elided");
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
    writeFileSync(join(dir, ".grafly", ".cache", "active-session"), "s2");
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
