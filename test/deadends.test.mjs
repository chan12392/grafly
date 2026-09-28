// deadends.js: the journal that turns a repeated failed search into a stamp
// check. Covers query normalization, the record/check roundtrip keyed by
// q+scope, fingerprint invalidation when the searched scope changes on disk,
// cap eviction, the save/load roundtrip, and the CLI wiring end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { checkDeadend, loadDeadends, normalizeQuery, recordMiss, saveDeadends, statScope } from "../dist/search/deadends.js";

const CLI = join(process.cwd(), "dist", "cli.js");
const run = (d, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: d, encoding: "utf8" });
const fp = (files, maxMtimeMs = 1000) => ({ version: 2, files, maxMtimeMs, digest: `${files}:${maxMtimeMs}` });

test("normalizeQuery preserves significant case, whitespace, and quoting", () => {
    assert.equal(normalizeQuery("  ApplyPatch  "), "  ApplyPatch  ");
    assert.equal(normalizeQuery('"Foo   Bar"'), '"Foo   Bar"');
    assert.equal(normalizeQuery("`Baz`"), "`Baz`");
    assert.equal(normalizeQuery("'\"nested\"'"), "'\"nested\"'");
    // Unmatched or inner quotes stay — only paired surrounding ones strip.
    assert.equal(normalizeQuery('"lead only'), '"lead only');
    assert.equal(normalizeQuery('has "inner" quotes'), 'has "inner" quotes');
    assert.equal(normalizeQuery(""), "");
});

test("recordMiss + checkDeadend roundtrip, keyed by normalized q + scope", () => {
    const j = [];
    recordMiss(j, { query: "applyPatch", scope: "", scopeFingerprint: fp(3, 100), filesSearched: 3 });
    assert.equal(checkDeadend(j, { query: '  "APPLYPATCH" ', scope: "" }, fp(3, 100)), null);
    const hit = checkDeadend(j, { query: 'applyPatch', scope: "" }, fp(3, 100));
    assert.ok(hit, "same exact query + same stamp must hit");
    assert.equal(hit.q, "applyPatch");
    assert.equal(hit.filesSearched, 3);
    // Same query, different scope: different question, no hit.
    assert.equal(checkDeadend(j, { query: "applypatch", scope: "src" }, fp(3, 100)), null);
    // Scope moved under our feet: count or max mtime changed — no hit.
    assert.equal(checkDeadend(j, { query: "applypatch", scope: "" }, fp(4, 100)), null);
    assert.equal(checkDeadend(j, { query: "applypatch", scope: "" }, fp(3, 200)), null);
    // Re-recording the same q+scope replaces the entry rather than duplicating.
    recordMiss(j, { query: "applyPatch", scope: "", scopeFingerprint: fp(3, 200) });
    assert.equal(j.length, 1);
    assert.equal(j[0].scopeFingerprint.maxMtimeMs, 200);
});

test("statScope stamps the real source set; changes invalidate the miss", () => {
    const d = mkdtempSync(join(tmpdir(), "grafly-deadend-"));
    mkdirSync(join(d, "src"), { recursive: true });
    writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n");
    // A doc the grep can never read does not count toward the stamp.
    writeFileSync(join(d, "notes.txt"), "not source\n");
    const ctx = join(d, ".grafly");
    const before = statScope(d, undefined, ctx);
    assert.equal(before.files, 1);
    assert.deepEqual(statScope(d, undefined, ctx), before, "unchanged tree, identical stamp");

    const j = [];
    recordMiss(j, { query: "zzz", scope: "", scopeFingerprint: before });
    assert.ok(checkDeadend(j, { query: "zzz", scope: "" }, statScope(d, undefined, ctx)));

    // A new source file in scope must invalidate the recorded miss.
    writeFileSync(join(d, "src", "b.ts"), "export const b = 2;\n");
    const grew = statScope(d, undefined, ctx);
    assert.equal(grew.files, 2);
    assert.equal(checkDeadend(j, { query: "zzz", scope: "" }, grew), null);

    // So must an edit that moves the newest mtime (utimes keeps this
    // deterministic — no sleeping for the clock).
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(d, "src", "a.ts"), future, future);
    const touched = statScope(d, undefined, ctx);
    assert.ok(touched.maxMtimeMs >= future.getTime());
    assert.equal(checkDeadend(j, { query: "zzz", scope: "" }, touched), null);

    // The ignorePredicate narrows the stamp to a sub-scope (--in): a scope
    // that rejects every file is the empty stamp.
    assert.equal(statScope(d, () => true, ctx).files, 0);
    const onlySrc = statScope(d, (rel) => !rel.startsWith("src/"), ctx);
    assert.equal(onlySrc.files, 2);
});

test("journal evicts the oldest entry past the cap", () => {
    const j = [];
    for (let i = 0; i < 55; i++)
        recordMiss(j, { query: `q${i}`, scope: "", scopeFingerprint: fp(1) });
    assert.equal(j.length, 50);
    assert.equal(checkDeadend(j, { query: "q4", scope: "" }, fp(1)), null, "oldest five are gone");
    assert.ok(checkDeadend(j, { query: "q5", scope: "" }, fp(1)), "q5 survives");
    assert.ok(checkDeadend(j, { query: "q54", scope: "" }, fp(1)), "newest survives");
});

test("saveDeadends/loadDeadends roundtrip; load is fail-open", () => {
    const d = mkdtempSync(join(tmpdir(), "grafly-deadend-"));
    assert.deepEqual(loadDeadends(d), [], "missing file reads as empty journal");
    const j = [];
    recordMiss(j, { query: "X", scope: "s", scopeFingerprint: fp(2, 5), filesSearched: 2 });
    assert.equal(saveDeadends(d, j), true);
    const back = loadDeadends(d);
    assert.equal(back.length, 1);
    assert.equal(back[0].q, "X");
    assert.ok(checkDeadend(back, { query: "X", scope: "s" }, fp(2, 5)));
});

test("grep journals a miss and answers the repeat from the journal", () => {
    const d = mkdtempSync(join(tmpdir(), "grafly-deadend-"));
    mkdirSync(join(d, "src"), { recursive: true });
    writeFileSync(join(d, "src", "a.ts"), "export function helper(): number { return 1; }\n");
    writeFileSync(join(d, "src", "b.ts"), 'import { helper } from "./a";\nexport const b = helper();\n');
    assert.equal(run(d, ["build"]).status, 0, "build");

    const first = run(d, ["grep", "definitelyAbsentSymbol", "--fixed", "--no-refresh"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /no hits for "definitelyAbsentSymbol"/);
    assert.doesNotMatch(first.stderr, /dead-end hit/);

    // The verified repeat: same zero-hit note, plus the marker, no search.
    const second = run(d, ["grep", "definitelyAbsentSymbol", "--fixed", "--no-refresh"]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /no hits for "definitelyAbsentSymbol" in \d+ indexed files/);
    assert.match(second.stderr, /dead-end hit — 'definitelyAbsentSymbol' verified absent \(scope unchanged\)/);

    // A different match mode is a different question — full search again.
    const insensitive = run(d, ["grep", "definitelyAbsentSymbol", "-i", "--fixed", "--no-refresh"]);
    assert.equal(insensitive.status, 0, insensitive.stderr);
    assert.doesNotMatch(insensitive.stderr, /dead-end hit/);

    // Move a source file's mtime: scope changed, real search must run.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(d, "src", "a.ts"), future, future);
    const third = run(d, ["grep", "definitelyAbsentSymbol", "--fixed", "--no-refresh"]);
    assert.equal(third.status, 0, third.stderr);
    assert.doesNotMatch(third.stderr, /dead-end hit/);
    assert.match(third.stderr, /no hits/);
});
