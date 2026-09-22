import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { escalateAmbiguous, escalationLines, mcConfig } from "../dist/circuit/escalate.js";

const ROOT = "C:/repo/under/test";

function stubMcHome(mode) {
    // A fake morecoffee checkout: python -m resolves packages from cwd, so a
    // minimal package tree answers with a canned envelope — exercises the
    // real spawn+protocol without needing morecoffee installed.
    const home = mkdtempSync(join(tmpdir(), "grafly-mc-stub-"));
    const pkg = join(home, "morecoffee", "channels");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(home, "morecoffee", "__init__.py"), "");
    writeFileSync(join(pkg, "__init__.py"), "");
    writeFileSync(join(pkg, "code_relation_stdio.py"), `import json,sys
body=json.loads(sys.stdin.buffer.read())
mode=${JSON.stringify(mode)}
out={"schema_version":"mc.channel.v1","request_id":"grafly-code-relation",
 "channel_id":"code_relation","operation":"judge","status":"ok",
 "decision":None,"scores":[],"evidence":[],"reason_codes":[],"limitations":[]}
if mode=="resolve":
    out["decision"]={"selected":body["candidates"][0]["id"],"verdict":"evidence_found"}
    out["evidence"]=[{"type":"resolved_reference","path":body["query"]["file"],"line":3}]
elif mode=="abstain":
    out["status"]="abstained"; out["reason_codes"]=["no_static_evidence"]
sys.stdout.buffer.write(json.dumps(out).encode())
`);
    return home;
}

const MATCHES = [
    { id: "a/mod.py#work", name: "work", path: "a/mod.py" },
    { id: "b/mod.py#work", name: "work", path: "b/mod.py" },
];
const DROPPED = [{ source: "caller.py#main", name: "work" }];

function withEnv(patch, fn) {
    const saved = {};
    for (const k of Object.keys(patch)) { saved[k] = process.env[k]; process.env[k] = patch[k]; }
    try { return fn(); }
    finally { for (const k of Object.keys(patch)) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    } }
}

test("unset GRAFLY_MC_HOME is a pure no-op", () => {
    withEnv({ GRAFLY_MC_HOME: "", GRAFLY_MC: "1", GRAFLY_NO_MC: "" }, () => {
        assert.equal(mcConfig(ROOT), null);
        assert.equal(escalateAmbiguous(ROOT, "work", MATCHES, DROPPED), null);
        assert.equal(escalationLines(null), null);
    });
});

test("resolved site maps to the selected candidate", () => {
    const home = stubMcHome("resolve");
    withEnv({ GRAFLY_MC_HOME: home, GRAFLY_MC: "1", GRAFLY_NO_MC: "" }, () => {
        const esc = escalateAmbiguous(ROOT, "work", MATCHES, DROPPED);
        assert.equal(esc.resolved.length, 1);
        assert.equal(esc.resolved[0].site, "caller.py");
        assert.equal(esc.resolved[0].candidate, "a/mod.py#work");
        assert.equal(esc.unresolved.length + esc.errors.length, 0);
        const lines = escalationLines(esc);
        assert.match(lines[0], /1\/1 dropped call site/);
        assert.match(lines[1], /caller\.py → a\/mod\.py#work/);
    });
});

test("mc abstain stays unresolved and honest", () => {
    const home = stubMcHome("abstain");
    withEnv({ GRAFLY_MC_HOME: home, GRAFLY_MC: "1", GRAFLY_NO_MC: "" }, () => {
        const esc = escalateAmbiguous(ROOT, "work", MATCHES, DROPPED);
        assert.equal(esc.resolved.length, 0);
        assert.equal(esc.unresolved[0].status, "abstained");
        assert.deepEqual(esc.unresolved[0].reasons, ["no_static_evidence"]);
        assert.match(escalationLines(esc).join("\n"), /still unknown/);
    });
});

test("spawn failure degrades to an error note, never throws", () => {
    withEnv({ GRAFLY_MC_HOME: "C:/no/such/dir", GRAFLY_MC_PYTHON: "python",
        GRAFLY_MC: "1", GRAFLY_NO_MC: "" }, () => {
        const esc = escalateAmbiguous(ROOT, "work", MATCHES, DROPPED);
        assert.equal(esc.resolved.length, 0);
        assert.equal(esc.errors.length, 1);
        assert.match(escalationLines(esc).join("\n"), /mc unavailable/);
    });
});

test("dropped sites for other names do not escalate", () => {
    const home = stubMcHome("resolve");
    withEnv({ GRAFLY_MC_HOME: home, GRAFLY_MC: "1", GRAFLY_NO_MC: "" }, () => {
        assert.equal(escalateAmbiguous(ROOT, "work", MATCHES,
            [{ source: "x.py#f", name: "other" }]), null);
    });
});

test("kill switch wins over GRAFLY_MC_HOME", () => {
    const home = stubMcHome("resolve");
    withEnv({ GRAFLY_MC_HOME: home, GRAFLY_MC: "0" }, () => {
        assert.equal(escalateAmbiguous(ROOT, "work", MATCHES, DROPPED), null);
    });
});
