// answers.json answer cache: normalized query keys carrying the option bits,
// (mtime,size) freshness fingerprints over covered + index files, ~30-entry
// eviction, fail-open on missing/corrupt state. The tail is a CLI replay
// check: second identical ask answers from cache, an edit invalidates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadAnswers, saveAnswers, normalizeAsk, cacheKey, stampFiles, indexDeps, lookup, verify, store } from "../dist/ask/answer-cache.js";

const CLI = join(process.cwd(), "dist", "cli.js");
const run = (d, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: d, encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "grafly-anscache-"));
const fresh = () => ({ version: 1, entries: {} });

test("normalizeAsk: case, whitespace, and surrounding quotes collapse", () => {
    assert.equal(normalizeAsk('  "How does   writeSession   work?" '), "how does writesession work?");
    assert.equal(normalizeAsk("how does writesession work?"), "how does writesession work?");
    assert.equal(normalizeAsk("'where is X'"), "where is x");
    // Only a matching pair strips — an unbalanced quote is literal text.
    assert.equal(normalizeAsk('"unbalanced'), '"unbalanced');
});

test("cacheKey: normalized query plus every shaping option bit", () => {
    const base = { limit: "8" };
    assert.equal(cacheKey("How  does X work?", base), cacheKey('"how does x work?"', base));
    for (const variant of [
        { limit: "8", source: true },
        { limit: "8", full: true },
        { limit: "4" },
        { limit: "8", in: "dist" },
        { limit: "8", graphRank: false },
        { limit: "8", json: true },
    ])
        assert.notEqual(cacheKey("how does x work?", variant), cacheKey("how does x work?", base));
    // --in spellings reduce to the same normalized prefix.
    assert.equal(cacheKey("q", { in: "dist/" }), cacheKey("q", { in: "dist\\" }));
});

test("store + verify: clean stamp replays; touched or deleted file is stale", () => {
    const d = tmp();
    mkdirSync(join(d, "src"), { recursive: true });
    writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n");
    const cache = fresh();
    store(cache, "k1", { text: "answer one\n", files: stampFiles(d, ["src/a.ts"]) });
    const entry = lookup(cache, "k1");
    assert.ok(entry);
    assert.equal(entry.text, "answer one\n");
    assert.equal(verify(d, entry), true);

    // Same-size content rewrite still bumps mtime — forced via utimes so the
    // assertion doesn't depend on filesystem clock granularity.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(d, "src", "a.ts"), later, later);
    assert.equal(verify(d, entry), false);

    // A resized file is stale too.
    writeFileSync(join(d, "src", "a.ts"), "export const a = 2; // changed\n");
    assert.equal(verify(d, entry), false);

    // A deleted covered file is stale.
    const gone = fresh();
    writeFileSync(join(d, "src", "b.ts"), "export const b = 1;\n");
    store(gone, "k", { text: "t", files: stampFiles(d, ["src/b.ts"]) });
    rmSync(join(d, "src", "b.ts"));
    assert.equal(verify(d, lookup(gone, "k")), false);
});

test("store: cap evicts the oldest entries first", () => {
    const d = tmp();
    writeFileSync(join(d, "f.ts"), "x");
    const stamp = stampFiles(d, ["f.ts"]);
    const cache = fresh();
    for (let i = 0; i < 35; i++)
        store(cache, `q${i}`, { text: `a${i}`, files: stamp });
    assert.equal(Object.keys(cache.entries).length, 30);
    for (const k of ["q0", "q1", "q2", "q3", "q4"])
        assert.equal(cache.entries[k], undefined, `${k} should be evicted`);
    assert.ok(cache.entries["q34"], "newest survives");
});

test("load/save round-trip; missing or corrupt file loads empty, never throws", () => {
    const d = tmp();
    assert.deepEqual(loadAnswers(d).entries, {});
    const cache = fresh();
    store(cache, "k", { text: "t", files: {} });
    saveAnswers(d, cache);
    assert.ok(existsSync(join(d, ".cache", "answers.json")));
    assert.equal(lookup(loadAnswers(d), "k").text, "t");
    writeFileSync(join(d, ".cache", "answers.json"), "{not json");
    assert.deepEqual(loadAnswers(d).entries, {});
    // A path that can't be written (a FILE as .cache) must not break save.
    writeFileSync(join(d, "block"), "x");
    saveAnswers(join(d, "block"), cache);
});

test("indexDeps: wiring graph, ask sidecar, and concept cards are fingerprinted", () => {
    const d = tmp();
    mkdirSync(join(d, ".graph"), { recursive: true });
    mkdirSync(join(d, ".cache"), { recursive: true });
    writeFileSync(join(d, ".graph", "wiring.json"), "{}");
    writeFileSync(join(d, ".cache", "ask-index.json"), "{}");
    writeFileSync(join(d, "card.md"), "# card\n");
    writeFileSync(join(d, "not-a-card.txt"), "x");
    const stamp = stampFiles(d, indexDeps(d));
    const keys = Object.keys(stamp).map((p) => relative(d, p));
    assert.ok(keys.some((k) => k.endsWith("wiring.json")), "wiring.json stamped");
    assert.ok(keys.some((k) => k.endsWith("ask-index.json")), "ask-index.json stamped");
    assert.ok(keys.some((k) => k.endsWith("card.md")), "concept card stamped");
    assert.ok(!keys.some((k) => k.endsWith("not-a-card.txt")), "non-card excluded");
});

test("cli: second identical ask replays from cache; an edit invalidates", () => {
    const d = tmp();
    mkdirSync(join(d, "src"), { recursive: true });
    writeFileSync(join(d, "src", "util.ts"), "export function helper(): number { return 1; }\n");
    writeFileSync(join(d, "src", "main.ts"), 'import { helper } from "./util";\nexport function main(): number { return helper(); }\n');
    const b = run(d, ["build"]);
    assert.equal(b.status, 0, b.stderr);
    const q = "what calls helper";
    const first = run(d, ["ask", q]);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(!first.stdout.includes("cache hit"), "first run is a real ask");
    const second = run(d, ["ask", q]);
    assert.equal(second.status, 0, second.stderr);
    assert.ok(second.stdout.includes("cache hit"), second.stdout);
    // Same answer, replayed verbatim, with one marker line appended.
    assert.ok(second.stdout.startsWith(first.stdout), "replayed text is verbatim");
    // A covered-file edit invalidates the replay.
    writeFileSync(join(d, "src", "util.ts"), "export function helper(): number { return 2; }\n");
    const third = run(d, ["ask", q]);
    assert.equal(third.status, 0, third.stderr);
    assert.ok(!third.stdout.includes("cache hit"), "edited repo re-asks");
});
