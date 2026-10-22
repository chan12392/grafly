#!/usr/bin/env node
import { contextDirFor } from '../dist/context/node-file.js';
import { isExplicitLabel, jidFor } from '../dist/circuit/feedback.js';
/**
 * circuit-log.jsonl analyzer — mine the judgment log for ranking problems
 * and feedback labels. Usage:
 *
 *   node scripts/circuit-log-analyze.mjs <log.jsonl> [more.jsonl...]
 *   node scripts/circuit-log-analyze.mjs --dir <repo>     → <repo>/.grafly/circuit-log.jsonl
 *   --query X   drill into one query string
 *
 * Reports what an operator needs to tune the circuit:
 *   - verdict/reason mix (how often it abstains, and why)
 *   - confident top-1 quality flags (vendored/test top-1s = suspect wins)
 *   - abstain gap histogram (near-threshold calls = weight-sensitive)
 *   - feature usage (cwd_affinity dead when every call runs from repo root)
 *   - explicit evidence-backed reviews; legacy adoption is not correctness
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const paths = [];
let queryFilter = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir") {
        const repo = args[++i];
        const log = join(contextDirFor(repo), "circuit-log.jsonl");
        if (existsSync(log + ".1"))
            paths.push(log + ".1"); // rotated generation — history is data too
        paths.push(log);
    }
    else if (args[i] === "--query") queryFilter = args[++i];
    else paths.push(args[i]);
}
if (paths.length === 0) {
    console.error("usage: circuit-log-analyze.mjs <log.jsonl...> | --dir <repo> [--query X]");
    process.exit(1);
}

const records = [];
for (const p of paths) {
    if (!existsSync(p)) {
        console.error(`⚠ ${p} — not found, skipped`);
        continue;
    }
    for (const line of readFileSync(p, "utf8").split("\n")) {
        if (!line.trim())
            continue;
        try {
            const r = JSON.parse(line);
            if (!r || typeof r !== "object" || Array.isArray(r)) continue;
            r._src = p;
            records.push(r);
        }
        catch { /* partial line */ }
    }
}
const judges = records.filter((r) => r.type === "judge" || (!r.type && Array.isArray(r.scores)));
const adopts = records.filter((r) => r.type === "adopt");
const rejects = records.filter((r) => r.type === "reject");
const scoped = queryFilter ? judges.filter((r) => r.query === queryFilter) : judges;
const reviewed = new Map();
let invalidLabels = 0;
for (const label of records.filter(r => r.type === "label")) {
    const judgment = judges.find(j => isExplicitLabel(label, j));
    if (!judgment) { invalidLabels++; continue; }
    const key = `${judgment.root}|${judgment.jid ?? jidFor(judgment)}`;
    if (scoped.includes(judgment) && (!reviewed.has(key) || Date.parse(label.ts) >= Date.parse(reviewed.get(key).label.ts)))
        reviewed.set(key, { label, judgment });
}

const pct = (n, d) => d ? `${(100 * n / d).toFixed(0)}%` : "—";
const bucket = (g, edges) => edges.findIndex((e) => g < e);

console.log(`== ${paths.length} log(s): ${records.length} records — ${judges.length} judgments, ${adopts.length} adopt, ${rejects.length} reject${queryFilter ? ` (filtered: query="${queryFilter}")` : ""}`);

const verdicts = { confident: 0, abstain: 0 };
const reasons = new Map();
const separations = new Map();
const gaps = [0, 0, 0, 0, 0]; // [0,.1) [.1,.3) [.3,.45) [.45,.5) confident
const GAP_EDGES = [0.1, 0.3, 0.45, 0.5, Infinity];
let top1Vendored = 0, top1Test = 0, top1VendoredConf = 0, top1TestConf = 0, cwdUsed = 0, topUsed = 0;
const perQuery = new Map();
for (const r of scoped) {
    verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
    for (const part of String(r.reason ?? "").split("|"))
        reasons.set(part, (reasons.get(part) ?? 0) + 1);
    if (r.verdict === "confident") {
        gaps[4]++;
        const by = String(r.reason ?? "").split("|")[0];
        separations.set(by, (separations.get(by) ?? 0) + 1);
    }
    else if (Number.isFinite(r.gap))
        gaps[bucket(r.gap, GAP_EDGES)]++;
    const f0 = r.features?.[0];
    if (f0?.vendored === 1) {
        top1Vendored++;
        if (r.verdict === "confident") top1VendoredConf++;
    }
    if (f0?.test_path === 1) {
        top1Test++;
        if (r.verdict === "confident") top1TestConf++;
    }
    if (r.cwd) cwdUsed++;
    if (r.top != null) topUsed++;
    const q = perQuery.get(r.query) ?? { n: 0, conf: 0, top1s: new Map() };
    q.n++;
    if (r.verdict === "confident") q.conf++;
    const t1 = r.top1 ?? r.scores?.[0]?.id;
    if (t1) q.top1s.set(t1, (q.top1s.get(t1) ?? 0) + 1);
    perQuery.set(r.query, q);
}

console.log(`\nverdicts: confident ${verdicts.confident} (${pct(verdicts.confident, scoped.length)}), abstain ${verdicts.abstain} (${pct(verdicts.abstain, scoped.length)})`);
console.log(`reasons:  ${[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ") || "—"}`);
if (separations.size)
    console.log(`confident separated by: ${[...separations.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ")}`);
console.log(`abstain gaps: [0,.1)=${gaps[0]}  [.1,.3)=${gaps[1]}  [.3,.45)=${gaps[2]}  [.45,.5)=${gaps[3]}   (near-threshold [.3,.5) = ${gaps[2] + gaps[3]} — weight-sensitive)`);
console.log(`top-1 flags: vendored=${top1Vendored} (${top1VendoredConf} confident)  test=${top1Test} (${top1TestConf} confident)   ctx: cwd set=${cwdUsed}/${scoped.length}  --top used=${topUsed}`);

const reviews = [...reviewed.values()];
const targets = reviews.filter(({ label }) => label.expected !== "abstain");
const topMatches = targets.filter(({ label, judgment }) => label.expected === (judgment.top1 ?? judgment.scores?.[0]?.id)).length;
const correctVerdicts = reviews.filter(({ label, judgment }) => label.expected === "abstain"
    ? judgment.verdict === "abstain" : judgment.verdict === "confident" && label.expected === (judgment.top1 ?? judgment.scores?.[0]?.id)).length;
console.log(`\nexplicit reviews: ${reviews.length} (latest per judgment; invalid/unmatched labels: ${invalidLabels})`);
console.log(`reviewed verdict agreement: ${correctVerdicts}/${reviews.length} (${pct(correctVerdicts, reviews.length)})`);
console.log(`reviewed top-1 target matches: ${topMatches}/${targets.length} (${pct(topMatches, targets.length)})`);
console.log(`neutral navigation: ${records.filter(r => r.type === "narrow").length}; legacy adopt=${adopts.length} reject=${rejects.length} (not correctness labels)`);
if (!reviews.length) console.log("No verified labels: use grafly feedback <jid> <candidate-id|abstain> --evidence <verification>.");

console.log(`\nper query (n=${perQuery.size}):`);
for (const [q, s] of [...perQuery.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const tops = [...s.top1s.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
        .map(([id, n]) => `${id.split("/").pop()}×${n}`).join(", ");
    console.log(`  ${s.n}× ${q}  conf ${pct(s.conf, s.n)}  top1: ${tops}`);
}
