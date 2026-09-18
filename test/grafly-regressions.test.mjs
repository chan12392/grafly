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
