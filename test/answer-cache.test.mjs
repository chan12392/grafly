// answers.json answer cache: original query keys carrying the option bits,
// (mtime,size) freshness fingerprints over covered + index files, ~30-entry
// eviction, fail-open on missing/corrupt state. The tail is a CLI replay
// check: second identical ask answers from cache, an edit invalidates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadAnswers, saveAnswers, cacheKey, stampFiles, indexDeps, lookup, verify, store } from "../dist/ask/answer-cache.js";
import { writeLink, clearLink, writeRulesCache } from '../dist/brain/link.js';

const CLI = join(process.cwd(), "dist", "cli.js");
const run = (d, args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { windowsHide: true, cwd: d, encoding: "utf8", env: { ...process.env, ...env } });
const tmp = () => mkdtempSync(join(tmpdir(), "grafly-anscache-"));
const fresh = () => ({ version: 4, entries: {} });

test("cache keys preserve exact case, whitespace and surrounding quotes", () => {
    const queries = ['getUserName', 'getusername', '"getUserName"', "'getUserName'", 'a b', 'a  b'];
    assert.equal(new Set(queries.map(q => cacheKey(q, {}))).size, queries.length);
});

test("cacheKey: normalized query plus every shaping option bit", () => {
    const base = { limit: "8" };
    assert.notEqual(cacheKey("How  does X work?", base), cacheKey('"how does x work?"', base));
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
    assert.doesNotMatch(second.stdout, /tokens saved ≈/, "cache replay saves computation, not model context");
    // Same answer, replayed verbatim, with one marker line appended.
    assert.ok(second.stdout.startsWith(first.stdout), "replayed text is verbatim");
    // A covered-file edit invalidates the replay.
    writeFileSync(join(d, "src", "util.ts"), "export function helper(): number { return 2; }\n");
    const third = run(d, ["ask", q]);
    assert.equal(third.status, 0, third.stderr);
    assert.ok(!third.stdout.includes("cache hit"), "edited repo re-asks");
});

test("cli cache preserves identifier case and literal quotes and rejects legacy keys", () => {
    const d = tmp();
    writeFileSync(join(d, 'user.ts'), 'export function getUserName() { return "name"; }\n');
    const built = run(d, ['build']); assert.equal(built.status, 0, built.stderr);
    const cache = join(d, '.grafly', '.cache', 'answers.json');
    for (const query of ['getusername', '"getUserName"']) {
        const primed = run(d, ['ask', 'getUserName', '--no-refresh']);
        assert.equal(primed.status, 0, primed.stderr);
        const result = run(d, ['ask', query, '--no-refresh']);
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stdout, /answer cache hit/);
        rmSync(cache);
        const cold = run(d, ['ask', query, '--no-refresh']);
        assert.equal(cold.status, 0, cold.stderr);
        assert.equal(result.stdout, cold.stdout, 'warm variant equals a cold query');
        rmSync(cache);
    }
    writeFileSync(cache, JSON.stringify({ version: 1, entries: { [cacheKey('getusername', { limit: '8' })]: {
        text: 'wrong legacy answer', stamp: {}, ts: Date.now(),
    } } }));
    const fresh = run(d, ['ask', 'getusername', '--no-refresh']);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.doesNotMatch(fresh.stdout, /wrong legacy answer|answer cache hit/);
});

test('CLI answer cache follows first Brain note, rule replacement and disconnect', () => {
    const d = tmp();
    writeFileSync(join(d, 'user.js'), 'export function greet(name) { return name; }\n');
    const built = run(d, ['build']); assert.equal(built.status, 0, built.stderr);
    const ask = () => {
        const r = run(d, ['ask', 'greet', '--source', '--json', '--no-refresh']);
        assert.equal(r.status, 0, r.stderr); return r;
    };
    ask();
    assert.match(ask().stderr, /answer cache hit/);
    const graph = JSON.parse(readFileSync(join(d, '.grafly', '.graph', 'wiring.json'), 'utf8'));
    const symbol = graph.nodes.find(n => n.name === 'greet' && n.kind !== 'file');
    const firstRule = 'Always hide personal names.';
    const noted = run(d, ['brain', 'note', '--symbol', symbol.id, '--rule', firstRule]);
    assert.equal(noted.status, 0, noted.stderr);
    const afterNote = ask();
    assert.doesNotMatch(afterNote.stderr, /answer cache hit/);
    assert.ok(afterNote.stdout.includes(firstRule));
    assert.match(ask().stderr, /answer cache hit/);
    const rulesPath = join(d, '.grafly', '.cache', 'brain-rules.json');
    const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
    rules.rules[0].rule = 'Replacement team rule with different text.';
    writeFileSync(rulesPath, JSON.stringify(rules));
    assert.ok(ask().stdout.includes(rules.rules[0].rule));
    rmSync(rulesPath);
    assert.doesNotMatch(ask().stdout, /Replacement team rule/);
    const newNote = run(d, ['brain', 'note', '--symbol', symbol.id, '--rule', firstRule]);
    assert.equal(newNote.status, 0, newNote.stderr);
    assert.ok(ask().stdout.includes(firstRule));
    const configPath = join(d, '.grafly', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const brain = config.brain;
    delete config.brain;
    writeFileSync(configPath, JSON.stringify(config));
    assert.ok(!ask().stdout.includes(firstRule), 'disconnect invalidates rule-bearing answers');
    const legacyPath = join(d, '.graft', 'config.json');
    mkdirSync(join(d, '.graft'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({ ...config, brain }));
    rmSync(configPath);
    assert.ok(ask().stdout.includes(firstRule), 'legacy config still supplies the Brain link');
    writeFileSync(legacyPath, JSON.stringify(config));
    assert.ok(!ask().stdout.includes(firstRule), 'legacy disconnect invalidates cached rules');
    // Earlier caches lack Brain identity or source-boundary validation.
    for (const version of [2, 3]) {
        writeFileSync(join(d, '.grafly', '.cache', 'answers.json'), JSON.stringify({ version, entries: { stale: {} } }));
        assert.deepEqual(loadAnswers(join(d, '.grafly')).entries, {});
    }
});

test('CLI cached answers follow Brain environment overrides without storing tokens', () => {
    const d = tmp();
    writeFileSync(join(d, 'user.js'), 'export function getUserName(user) { return user.name; }\n');
    const built = run(d, ['build']); assert.equal(built.status, 0, built.stderr);
    const graph = JSON.parse(readFileSync(join(d, '.grafly', '.graph', 'wiring.json'), 'utf8'));
    const node = graph.nodes.find(n => n.name === 'getUserName' && n.kind !== 'file');
    const link = { brainId: 'env-team', token: 'synthetic-env-token', baseUrl: 'https://brain.example.test' };
    const rule = 'Keep the team-specific rule in this answer.';
    writeLink(d, link);
    writeRulesCache(d, { brainId: link.brainId, fetchedAt: Date.now(), rules: [
        { symbol: node.id, fingerprint: node.body_hash, rule },
    ] });
    clearLink(d);
    const opts = ['ask', 'getUserName', '--source', '--json', '--no-refresh'];
    const ask = env => {
        const result = run(d, opts, env);
        assert.equal(result.status, 0, result.stderr);
        return result;
    };
    assert.ok(!ask().stdout.includes(rule));
    assert.match(ask().stderr, /answer cache hit/);
    const env = { GRAFLY_BRAIN_ID: link.brainId, GRAFLY_BRAIN_TOKEN: link.token, GRAFLY_BRAIN_URL: link.baseUrl };
    const linked = ask(env);
    assert.doesNotMatch(linked.stderr, /answer cache hit/);
    assert.ok(linked.stdout.includes(rule));
    assert.match(ask(env).stderr, /answer cache hit/);
    for (const variant of [
        { GRAFLY_BRAIN_ID: 'other-team' },
        { GRAFLY_BRAIN_TOKEN: 'changed-token' },
        { GRAFLY_BRAIN_URL: 'https://other-brain.example.test' },
    ]) {
        const result = ask({ ...env, ...variant });
        assert.doesNotMatch(result.stderr, /answer cache hit/);
        assert.ok(!result.stdout.includes(rule));
    }
    assert.ok(!ask().stdout.includes(rule), 'removing the environment link restores code-only answers');
    rmSync(join(d, '.grafly', '.cache', 'answers.json'));
    assert.equal(ask(env).stdout, linked.stdout, 'warm environment transition matches a cold answer');
    for (const filename of ['answers.json', 'brain-rules.json']) {
        const cached = readFileSync(join(d, '.grafly', '.cache', filename), 'utf8');
        assert.ok(!cached.includes(link.token), 'cache identity does not expose credentials');
    }
});
