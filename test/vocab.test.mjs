// vocab.js: the project-dialect store (.grafly/vocab.json). Asserts the five
// extraction categories, the repo/llm merge keeping per-value provenance,
// `vocab ingest` accumulating across runs, and the per-value exemplar cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { extractVocab, mergeVocab, finalizeVocab, saveRepoVocab, addLlmVocab, loadVocab, mergedVocab } from "../dist/vocab.js";

const CLI = join(process.cwd(), "dist", "cli.js");
const run = (d, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: d, encoding: "utf8" });

test("extractVocab: all five categories, expected members", () => {
    const src = [
        'import { helperFn } from "./util";',
        'const NODE_ENV = process.env.NODE_ENV;',
        'const url = "https://example.com/x";',
        'const flag = "--verbose";',
        'function parseConfig(opts) {',
        '  if (opts) helperFn(opts);',
        '  helperFn(opts); helperFn(opts);',
        "  return opts.alpha - opts.beta + opts.gamma;",
        "  return opts.alpha - opts.beta + opts.gamma;",
        "  return opts.alpha - opts.beta + opts.gamma;",
        "}",
    ].join("\n");
    const v = extractVocab("src/a.js", src, "javascript");

    const morphs = v.identifierMorphemes;
    assert.ok(morphs.get("parse")?.count >= 1 && morphs.get("config")?.count >= 1, "camelCase split");
    assert.ok(morphs.get("helper")?.count >= 1 && morphs.get("fn")?.count >= 1);
    assert.ok(!morphs.has("if"), "keywords dropped");
    assert.ok(!morphs.has("o"), "single letters dropped");

    assert.ok(v.moduleSpecifiers.has("./util"), "from-specifier");
    assert.ok(v.calledNames.has("helperFn"), "call sites counted");
    assert.equal(v.calledNames.get("helperFn").count, 3);
    assert.ok(!v.calledNames.has("parseConfig"), "declaration is not a call");
    assert.ok(!v.calledNames.has("if"), "keyword callee dropped");

    assert.ok(v.literalShapes.has("env:NODE_ENV"), "process.env.X + SCREAMING_SNAKE → env");
    assert.ok(v.literalShapes.has("url:https://example.com/x"), "url shape");
    assert.ok(v.literalShapes.has("flag:--verbose"), "flag shape");

    const idiom = v.idioms.get("return opts alpha");
    assert.ok(idiom && idiom.count >= 3, "repeated 3-token sequence is an idiom");
});

test("extractVocab: exemplar cap and line numbers", () => {
    const src = Array.from({ length: 10 }, (_, i) => `helperFn(${i});`).join("\n");
    const v = extractVocab("src/b.js", src, "javascript");
    const e = v.calledNames.get("helperFn");
    assert.equal(e.count, 10);
    assert.equal(e.exemplars.length, 3, "exemplars capped at 3");
    assert.deepEqual(e.exemplars.map((x) => x.line), [1, 2, 3]);
    assert.ok(e.exemplars.every((x) => x.path === "src/b.js"));
});

test("store: repo + llm sources keep provenance on shared values", () => {
    const d = mkdtempSync(join(tmpdir(), "grafly-vocab-"));
    const outDir = join(d, ".grafly");
    const src = 'import { thing } from "./dep";\nthing();\nthing();\n';
    const acc = {};
    mergeVocab(acc, extractVocab("a.js", src, "javascript"));
    const cats = finalizeVocab(acc);

    saveRepoVocab(outDir, cats);
    addLlmVocab(outDir, cats); // same vocabulary from the llm side
    const store = loadVocab(outDir);
    assert.equal(store.version, 1);
    assert.ok(store.sources.repo.generatedAt && store.sources.llm.updatedAt, "both stamps");

    const card = mergedVocab(store);
    const called = card.calledNames.find((r) => r.value === "thing");
    assert.equal(called.provenance, "repo+llm");
    assert.equal(called.count, 4, "counts sum across provenances");
    const specs = card.moduleSpecifiers.find((r) => r.value === "./dep");
    assert.equal(specs.provenance, "repo+llm");

    // A value only the llm side knows stays [llm].
    addLlmVocab(outDir, finalizeVocab(mergeVocab({}, extractVocab("gen.js", "soloCall();\n", "javascript"))));
    const card2 = mergedVocab(loadVocab(outDir));
    assert.equal(card2.calledNames.find((r) => r.value === "soloCall").provenance, "llm");
    assert.equal(card2.calledNames.find((r) => r.value === "thing").provenance, "repo+llm");
    // ...and re-saving the repo source leaves the llm source alone.
    saveRepoVocab(outDir, cats);
    assert.equal(mergedVocab(loadVocab(outDir)).calledNames.find((r) => r.value === "soloCall").provenance, "llm");
});

test("cli: build fills repo, vocab ingest accumulates into llm, card merges", () => {
    const d = mkdtempSync(join(tmpdir(), "grafly-vocab-cli-"));
    mkdirSync(join(d, "src"), { recursive: true });
    writeFileSync(join(d, "src", "util.ts"), "export function dialectHelper(): number { return 1; }\nexport function mainThing(): number { return dialectHelper(); }\n");

    const b = run(d, ["build"]);
    assert.equal(b.status, 0, b.stderr);
    const vocabFile = join(d, ".grafly", "vocab.json");
    assert.ok(existsSync(vocabFile), "build emits .grafly/vocab.json");
    let store = JSON.parse(readFileSync(vocabFile, "utf8"));
    assert.ok(store.sources.repo.categories.calledNames.length > 0, "repo source filled");
    assert.ok(!store.sources.llm, "no llm source before ingest");

    // llm-written file, named explicitly — ingest twice: merges accumulate.
    writeFileSync(join(d, "generated.js"), "dialectHelper();\ndialectHelper();\n");
    for (let i = 0; i < 2; i++) {
        const ing = run(d, ["vocab", "ingest", "generated.js"]);
        assert.equal(ing.status, 0, ing.stderr);
    }
    store = JSON.parse(readFileSync(vocabFile, "utf8"));
    const llmCalled = store.sources.llm.categories.calledNames.find((r) => r.value === "dialectHelper");
    assert.equal(llmCalled.count, 4, "second ingest adds to the first");
    assert.ok(store.sources.repo.categories.calledNames.length > 0, "repo source not clobbered");

    const card = run(d, ["vocab", "--no-refresh"]);
    assert.equal(card.status, 0, card.stderr);
    assert.match(card.stdout, /dialectHelper×\d+ \[repo\+llm\]/, "shared value tagged repo+llm");
    assert.match(card.stdout, /identifierMorphemes:/);
});
