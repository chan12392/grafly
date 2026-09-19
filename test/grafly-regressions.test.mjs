import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextDirFor } from "../dist/context/node-file.js";
import { Grafly, Graft } from "../dist/engine.js";
import { canonicalToolName, GRAFLY_MCP_TOOL_CANONICAL } from "../dist/mcp/tool-names.js";
import { normalizeTraceDepth, splitWorkspaceScope } from "../dist/compat/options.js";
import { posthogKey } from "../dist/telemetry/key.js";
import { appendCircuitRecord, recordFollowup } from "../dist/circuit/feedback.js";

test("Grafly is primary engine and Graft remains alias",()=>assert.equal(Graft,Grafly));
test("default graph directory is grafly",()=>{const root=mkdtempSync(join(tmpdir(),"grafly-"));assert.equal(contextDirFor(root),join(root,"grafly"));});
test("MCP canonical names use grafly",()=>{assert.ok(GRAFLY_MCP_TOOL_CANONICAL.every(n=>n.startsWith("grafly_")));assert.equal(canonicalToolName("graft_find_code"),"grafly_find_code");});
test("trace depth all is infinite",()=>{assert.equal(normalizeTraceDepth("all"),Infinity);assert.equal(normalizeTraceDepth("4"),4);});
test("workspace scope splits child",()=>assert.deepEqual(splitWorkspaceScope("repoA/src",["repoA","repoB"]),{onlyChild:"repoA",childIn:"src"}));
test("telemetry has no baked key",()=>{const a=process.env.GRAFLY_POSTHOG_KEY,b=process.env.GRAFT_POSTHOG_KEY;delete process.env.GRAFLY_POSTHOG_KEY;delete process.env.GRAFT_POSTHOG_KEY;try{assert.equal(posthogKey(),"");}finally{if(a!==undefined)process.env.GRAFLY_POSTHOG_KEY=a;if(b!==undefined)process.env.GRAFT_POSTHOG_KEY=b;}});
test("narrowing is not adopt/reject",()=>{const d=mkdtempSync(join(tmpdir(),"grafly-log-")),p=join(d,"circuit-log.jsonl");appendCircuitRecord(p,{ts:new Date().toISOString(),type:"judge",jid:"j1",root:"/repo",query:"run",top1:"A",scores:[{id:"A",score:2},{id:"B",score:1},{id:"C",score:0}]});const ev=recordFollowup(p,"/repo","run",["A","B"]);assert.equal(ev.type,"narrow");const rows=readFileSync(p,"utf8").trim().split("\n").map(JSON.parse);assert.equal(rows.some(r=>r.type==="adopt"||r.type==="reject"),false);});

import { serverEntry, mergeJsonKey, stripTomlSection } from "../dist/hosts/mcp-config.js";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { sumSavingsFooters } from "../dist/context/savings.js";

test("MCP registration launches Grafly and migrates legacy JSON key", () => {
  assert.deepEqual(serverEntry(), { command: "grafly", args: ["mcp"] });
  const d = mkdtempSync(join(tmpdir(), "grafly-mcp-"));
  const p = join(d, "mcp.json");
  writeFileSync(p, JSON.stringify({ mcpServers: { graft: { command: "graft", args: ["mcp"] }, other: { command: "x" } } }));
  mergeJsonKey("x", p, "mcpServers", serverEntry());
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(cfg.mcpServers.grafly, { command: "grafly", args: ["mcp"] });
  assert.equal(cfg.mcpServers.graft, undefined);
  assert.deepEqual(cfg.mcpServers.other, { command: "x" });
});

test("TOML migration strips legacy Graft header", () => {
  const r = stripTomlSection("[mcp_servers.graft]\ncommand = \"graft\"\n\n[other]\nx=1\n");
  assert.equal(r.found, true);
  assert.match(r.rest, /\[other\]/);
  assert.doesNotMatch(r.rest, /mcp_servers\.graft/);
});

test("TOML migration also recognizes canonical Grafly header", () => {
  const r = stripTomlSection("[mcp_servers.grafly]\ncommand = \"grafly\"\n");
  assert.equal(r.found, true);
  assert.equal(r.rest, "");
});

test("CLI exposes one-command migration", () => {
  const cli = join(process.cwd(), "dist", "cli.js");
  const r = spawnSync(process.execPath, [cli, "migrate", "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Replace legacy Graft wiring\/cache with Grafly/);
});

test("Grafly skill uses only Grafly-facing commands", async () => {
  const { skillTemplate } = await import("../dist/claude/skill-template.js");
  const skill = skillTemplate();
  assert.match(skill, /name: grafly/);
  assert.match(skill, /grafly_trace_calls/);
  assert.doesNotMatch(skill, /\bgraft_find_code\b/);
});

test("savings parser accepts Grafly output and legacy Graft output", () => {
  assert.equal(sumSavingsFooters("[grafly] tokens saved ≈ 1,200\n[graft] tokens saved ≈ 300"), 1500);
});

import { mkdirSync, writeFileSync as writeFileSync2 } from "node:fs";
import { resolveContextDir, readBuildConfig, writeBuildConfig } from "../dist/util/state.js";
import { upsertSection } from "../dist/hosts/sections.js";
import { instructionBody } from "../dist/hosts/instructions.js";

test("resolveContextDir defaults to grafly, honors legacy graft and env override", () => {
  const bare = mkdtempSync(join(tmpdir(), "grafly-bare-"));
  assert.equal(resolveContextDir(bare), join(bare, "grafly"));
  mkdirSync(join(bare, "graft"));
  assert.equal(resolveContextDir(bare), join(bare, "graft"));
  mkdirSync(join(bare, "grafly"));
  assert.equal(resolveContextDir(bare), join(bare, "grafly"));
  const prev = process.env.GRAFLY_DIR;
  process.env.GRAFLY_DIR = "custom-ctx";
  try { assert.equal(resolveContextDir(bare), join(bare, "custom-ctx")); }
  finally { if (prev === undefined) delete process.env.GRAFLY_DIR; else process.env.GRAFLY_DIR = prev; }
});

test("build config writes .grafly and still reads legacy .graft", () => {
  const d = mkdtempSync(join(tmpdir(), "grafly-cfg-"));
  mkdirSync(join(d, ".graft"));
  writeFileSync2(join(d, ".graft", "config.json"), JSON.stringify({ includeDirs: ["src"] }));
  assert.deepEqual(readBuildConfig(d), { includeDirs: ["src"] });
  writeBuildConfig(d, { includeDirs: ["lib"] });
  assert.deepEqual(readBuildConfig(d), { includeDirs: ["lib"] });
});

test("upsertSection migrates a legacy graft-fenced block in place", () => {
  const d = mkdtempSync(join(tmpdir(), "grafly-sect-"));
  const p = join(d, "AGENTS.md");
  writeFileSync2(p, "head\n<!-- graft:start -->\nold body\n<!-- graft:end -->\ntail\n");
  const r = upsertSection(p, "new body");
  assert.equal(r.action, "replaced");
  const text = readFileSync(p, "utf8");
  assert.match(text, /<!-- grafly:start -->\nnew body\n<!-- grafly:end -->/);
  assert.doesNotMatch(text, /graft:start/);
});

test("instruction body is written with Grafly names only", () => {
  const body = instructionBody();
  assert.match(body, /## Grafly — repo context graph/);
  assert.match(body, /`grafly ask/);
  assert.doesNotMatch(body, /\bgraft\b/);
});

import { connectBrain } from "../dist/brain/connect.js";
import { readLink } from "../dist/brain/link.js";

test("connectBrain persists GRAFLY_BRAIN_URL into the stored link", async () => {
  const repo = mkdtempSync(join(tmpdir(), "grafly-repo-"));
  const home = mkdtempSync(join(tmpdir(), "grafly-home-"));
  const prev = process.env.GRAFLY_BRAIN_URL;
  process.env.GRAFLY_BRAIN_URL = "https://brain.example.test/grafly";
  try {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ anchors: [] }) });
    await connectBrain(repo, { brainId: "b_test", token: "bt_test" }, { home, fetchImpl });
    const link = readLink(repo);
    assert.equal(link.baseUrl, "https://brain.example.test/grafly");
  } finally {
    if (prev === undefined) delete process.env.GRAFLY_BRAIN_URL; else process.env.GRAFLY_BRAIN_URL = prev;
  }
});

import { spawn } from "node:child_process";

test("brain server serves the public brain API", async () => {
  const server = join(process.cwd(), "service", "brain-server.mjs");
  const data = mkdtempSync(join(tmpdir(), "grafly-brain-"));
  const port = 24000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, DATA_DIR: data, PORT: String(port) };
  const mint = spawnSync(process.execPath, [server, "create-brain", "--name", "t"], { env, encoding: "utf8" });
  const [brainId, token] = mint.stdout.trim().split(":");
  assert.ok(brainId && token, mint.stderr);
  const child = spawn(process.execPath, [server], { env, stdio: "ignore" });
  try {
    const base = `http://127.0.0.1:${port}`;
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch(`${base}/health`); if (r.ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    // No repo ingested yet: expected-repo check finds nothing, fails open.
    const repoInfo = await (await fetch(`${base}/api/public/brains/${brainId}/repo`, { headers: auth })).json();
    assert.equal(repoInfo.repo.slug, "");
    // Ingest a minimal digest; mining is skipped without BRAIN_LLM_*.
    const digest = { provider: "github", owner: "o", name: "r", head_sha: "x", default_branch: "main",
      is_private: true, commits: [{ sha: "abc1234", subject: "s", body: "", files: [], symbols: [] }],
      threads: [], symbols: [{ id: "f.js#fn", path: "f.js", name: "fn", kind: "function", signature: "", fingerprint: "h1" }],
      sources: [], auto_approve: false };
    const ing = await (await fetch(`${base}/api/public/brains/${brainId}/repo`, { method: "POST", headers: auth, body: JSON.stringify(digest) })).json();
    assert.match(ing.job_id, /^j_/);
    // A draft rule is hidden from anchors until approved.
    const { writeFileSync: wf } = await import("node:fs");
    wf(join(data, "rules", `${brainId}.json`), JSON.stringify({ rules: [
      { rule_id: "r1", symbol: "f.js#fn", fingerprint: "h1", rule: "never cache here", source_url: undefined, status: "draft" },
      { rule_id: "r2", symbol: "f.js#fn", fingerprint: "h1", rule: "approved rule", source_url: undefined, status: "approved" },
    ] }));
    let anchors = (await (await fetch(`${base}/api/public/brains/${brainId}/rules/anchors`, { headers: auth })).json()).anchors;
    assert.deepEqual(anchors.map((a) => a.rule_id), ["r2"]);
    await (await fetch(`${base}/api/public/brains/${brainId}/rules/approve/r1`, { method: "POST", headers: auth })).json();
    anchors = (await (await fetch(`${base}/api/public/brains/${brainId}/rules/anchors`, { headers: auth })).json()).anchors;
    assert.equal(anchors.length, 2);
    // Bad token is rejected.
    assert.equal((await fetch(`${base}/api/public/brains/${brainId}/rules/anchors`, { headers: { authorization: "Bearer nope" } })).status, 401);
    // Client-mined anchors can be pushed without any server-side LLM.
    const push = await (await fetch(`${base}/api/public/brains/${brainId}/rules`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ anchors: [{ symbol: "f.js#fn", rule: "agent-written note" }] }),
    })).json();
    assert.equal(push.added, 1);
    const after = (await (await fetch(`${base}/api/public/brains/${brainId}/rules/anchors`, { headers: auth })).json()).anchors;
    assert.equal(after.length, 3);
    assert.equal(after.find((a) => a.rule === "agent-written note").fingerprint, "h1");
  } finally {
    child.kill();
  }
});

import { ensureLocalBrain, addRules, pushNotes } from "../dist/brain/note.js";
import { pullBrain } from "../dist/brain/connect.js";

test("brain note mints a local brain, fingerprints rules, rejects unknowns", async () => {
  const repo = mkdtempSync(join(tmpdir(), "grafly-note-"));
  const { link, created } = ensureLocalBrain(repo);
  assert.equal(created, true);
  assert.equal(link.local, true);
  const graph = { nodes: [{ id: "f.js#fn", path: "f.js", name: "fn", kind: "function", body_hash: "h1" }] };
  const res = addRules(repo, [
    { rule: "never cache here", symbol: "f.js#fn" },
    { rule: "repo convention", repoWide: true },
    { rule: "bad anchor", symbol: "missing.js#nope" },
    { rule: "never cache here", symbol: "f.js#fn" },
  ], graph);
  assert.equal(res.added.length, 2);
  assert.equal(res.rejected.length, 2);
  assert.equal(res.added[0].fingerprint, "h1");
  // A local brain's pull never fetches — it rewrites sections from the cache.
  const pull = await pullBrain(repo, { home: mkdtempSync(join(tmpdir(), "grafly-home-")) });
  assert.equal(pull.local, true);
  assert.equal(pull.ruleCount, 2);
  // pushNotes is a no-op for a local brain.
  assert.equal((await pushNotes(repo, link, res.added)).pushed, 0);
});

test("ambiguous call sites surface instead of a silent undercount; abstain suppresses --top", () => {
  const d = mkdtempSync(join(tmpdir(), "grafly-amb-"));
  writeFileSync(join(d, "a.js"), "export function helper(){ return 1; }\n");
  writeFileSync(join(d, "b.js"), "export function helper(){ return 1; }\n");
  writeFileSync(join(d, "caller.js"), 'import {helper as h1} from "./a.js";\nexport function caller(){ return helper() + h1(); }\n');
  writeFileSync(join(d, "a2.js"), "export class Base {}\n");
  writeFileSync(join(d, "b2.js"), "export class Base {}\n");
  writeFileSync(join(d, "c.js"), "export class C extends Base {}\n");
  const cli = join(process.cwd(), "dist", "cli.js");
  const b = spawnSync(process.execPath, [cli, "build"], { cwd: d, encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  const r = JSON.parse(spawnSync(process.execPath, [cli, "callers", "helper", "--json"], { cwd: d, encoding: "utf8" }).stdout);
  assert.deepEqual(r.ambiguousCalls, [{ source: "caller.js#caller", name: "helper" }]);
  // The aliased import call resolves through the specifier: h1() → a.js#helper.
  const aHelper = r.matches.find((m) => m.symbol.id === "a.js#helper");
  assert.deepEqual(aHelper.hits.map((h) => h.id), ["caller.js#caller"]);
  // Two identical definitions ⇒ abstain ⇒ --top must not hide a match.
  const top = JSON.parse(spawnSync(process.execPath, [cli, "callers", "helper", "--json", "--top", "1"], { cwd: d, encoding: "utf8" }).stdout);
  assert.equal(top.circuit.verdict, "abstain");
  assert.equal(top.matches.length, 2);
  assert.equal(top.truncated, undefined);
  // mc.channel.v1 contract alignment: status vocabulary, reason codes as an
  // array, and score semantics (ranking score ≠ probability ⇒ confidence null).
  assert.equal(top.schema, "grafly.callers.v1");
  assert.equal(top.circuit.status, "abstained");
  assert.deepEqual(top.circuit.reasonCodes, top.circuit.reason.split("|"));
  assert.equal(top.circuit.scoreType, "learned_ranking_weight");
  assert.equal(top.circuit.confidence, null);
  // `class C extends Base` with an ambiguous Base keeps a name-literal edge —
  // callers on the real nodes must surface it as unattributed, not drop it.
  const r2 = JSON.parse(spawnSync(process.execPath, [cli, "callers", "Base", "--json"], { cwd: d, encoding: "utf8" }).stdout);
  assert.deepEqual(r2.unresolvedNameRefs, [{ source: "c.js#C", relation: "extends", name: "Base" }]);
  assert.match(r2.limitations.join(" "), /target the bare name/);
  // A miss offers near-miss suggestions and the grep escape hatch instead
  // of dead-ending into a full-tree grep.
  const miss = spawnSync(process.execPath, [cli, "callers", "heler"], { cwd: d, encoding: "utf8" });
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /near matches: helper/);
  assert.match(miss.stderr, /grafly grep/);
});

test("session-compact replaces old tool outputs with reversible pointers, expands back losslessly", () => {
  const d = mkdtempSync(join(tmpdir(), "grafly-sess-"));
  const big = "x".repeat(2000);
  const dup = "y".repeat(200); // <300B: no archive ref ⇒ first copy retained, second gets a dup pointer
  const verified = `${"v".repeat(1200)}\nok=true`;
  const rl = (payload) => JSON.stringify({ timestamp: "t", type: "response_item", payload });
  const msg = (id, role, text) => rl({ type: "message", id, role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
  const call = (id, cid, name) => rl({ type: "custom_tool_call", id, status: "completed", call_id: cid, name, input: "{}" });
  const out = (id, cid, text) => rl({ type: "custom_tool_call_output", id, call_id: cid, isError: false, output: [{ type: "input_text", text }] });
  const transcript = join(d, "rollout.jsonl");
  writeFileSync(transcript, [
    JSON.stringify({ type: "session_meta", payload: { id: "s1" } }),
    msg("u1", "user", "do the thing"),
    call("c1", "k1", "read"), out("o1", "k1", big),
    call("c2", "k2", "read"), out("o2", "k2", dup),
    call("c3", "k3", "read"), out("o3", "k3", dup),          // exact duplicate of o2
    call("c4", "k4", "test"), out("o4", "k4", verified),    // verification evidence — protected
    msg("a1", "assistant", "done"), msg("a2", "assistant", "summary"),
  ].join("\n"));
  const cli = join(import.meta.dirname, "..", "dist", "cli.js");
  const r = spawnSync(process.execPath, [cli, "session-compact", transcript, "--keep-last", "2", "--no-batches", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.status, "ok");
  assert.equal(res.decision.verdict, "compacted");
  // o1 archived, o3 duplicate pointer; o4 protected by retention rule.
  assert.equal(res.decision.compacted_message_count, 2);
  const protectedIds = res.decision.protected_messages.map((m) => m.message_id);
  assert.ok(protectedIds.includes("o4"), `o4 must be protected: ${protectedIds}`);
  const compacted = readFileSync(`${transcript}.compacted.jsonl`, "utf8");
  assert.match(compacted, /\[MC archived tool output; ref=[0-9a-f]{64}\.txt; sha256=[0-9a-f]{64}; bytes=2000\]/);
  assert.match(compacted, /\[MC exact duplicate of message o2; sha256=[0-9a-f]{64}; bytes=200\]/);
  // JSON-escaped inside the transcript — compare against the encoded form.
  assert.ok(compacted.includes(JSON.stringify(verified).slice(1, -1)), "verification output must remain verbatim");
  assert.ok(!compacted.includes(big), "archived output must leave the transcript");
  // Original transcript untouched; archive dir holds the original payload.
  assert.ok(readFileSync(transcript, "utf8").includes(big));
  const x = spawnSync(process.execPath, [cli, "session-expand", `${transcript}.compacted.jsonl`], { encoding: "utf8" });
  assert.equal(x.status, 0, x.stderr);
  assert.equal(readFileSync(`${transcript}.restored.jsonl`, "utf8"), readFileSync(transcript, "utf8"),
    "restoration must preserve every raw byte, including multipart output shape");
  // Abstain when the budget can't be met without protected loss.
  const ab = JSON.parse(spawnSync(process.execPath, [cli, "session-compact", transcript, "--target-bytes", "200", "--json"], { encoding: "utf8" }).stdout);
  assert.equal(ab.status, "abstained");
  assert.ok(ab.reason_codes.includes("target_unreachable_without_protected_loss"));
});
