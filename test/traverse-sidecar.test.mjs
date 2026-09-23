// wiring-traverse.json: the slim sidecar callers/grep parse instead of the
// full wiring graph. Asserts it is emitted at build, carries only traversal
// fields, and that deleting it degrades callers to identical output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const CLI = join(process.cwd(), "dist", "cli.js");
const run = (d, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: d, encoding: "utf8" });

test("traverse sidecar: emitted, slim, and callers identical without it", () => {
    const d = mkdtempSync(join(tmpdir(), "grafly-tside-"));
    mkdirSync(join(d, "src"), { recursive: true });
    writeFileSync(join(d, "src", "util.ts"), "export function helper(): number { return 1; }\n");
    writeFileSync(join(d, "src", "main.ts"), 'import { helper } from "./util";\nexport function main(): number { return helper(); }\n');
    const b = run(d, ["build"]);
    assert.equal(b.status, 0, b.stderr);

    const graphDir = join(d, ".grafly", ".graph");
    const wiring = join(graphDir, "wiring.json");
    const sidecar = join(graphDir, "wiring-traverse.json");
    assert.ok(existsSync(wiring), "wiring.json");
    assert.ok(existsSync(sidecar), "wiring-traverse.json emitted alongside wiring.json");

    const slim = JSON.parse(readFileSync(sidecar, "utf8"));
    assert.ok(slim.nodes.length > 0 && slim.edges.length > 0);
    for (const n of slim.nodes) {
        for (const k of ["id", "name", "kind", "path", "span"])
            assert.ok(n[k] !== undefined, `node ${n.id} missing ${k}`);
        for (const k of ["signature", "summary", "crux", "body_hash", "body_text", "exported"])
            assert.equal(n[k], undefined, `node ${n.id} leaks ${k}`);
    }
    for (const e of slim.edges) {
        assert.deepEqual(Object.keys(e).sort(), ["relation", "source", "target"]);
    }
    assert.ok(statSync(sidecar).size < statSync(wiring).size, "sidecar is smaller than wiring.json");

    const withSlim = JSON.parse(run(d, ["callers", "helper", "--json"]).stdout);
    assert.deepEqual(withSlim.matches[0].hits.map((h) => h.id), ["src/main.ts#main"]);
    const g = run(d, ["grep", "helper", "--fixed", "--json"]);
    assert.equal(g.status, 0, g.stderr);
    assert.ok(JSON.parse(g.stdout).totalHits > 0);

    // Old indexes have no sidecar: callers must degrade to identical output.
    rmSync(sidecar);
    const without = JSON.parse(run(d, ["callers", "helper", "--json"]).stdout);
    assert.deepEqual(without, withSlim);
});
