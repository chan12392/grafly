// Python `imports` edges must land on in-repo files, not stay raw specifiers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../dist/graph/build.js";

test("relative and root-absolute Python imports resolve to repo files", async () => {
    const d = mkdtempSync(join(tmpdir(), "grafly-pyimp-"));
    const put = (rel, src) => { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), src); };
    put("pkg/__init__.py", "");
    put("pkg/b.py", "def x():\n    return 1\n");
    put("pkg/sub/c.py", "from ..b import x\nfrom .. import b\n");
    put("main.py", "import pkg.b\nimport os\n");
    await buildGraph(d, {});
    const g = JSON.parse(readFileSync(join(d, ".grafly", ".graph", "wiring.json"), "utf8"));
    const imports = (src) => g.edges.filter((e) => e.relation === "imports" && e.source === src).map((e) => e.target).sort();
    assert.deepEqual(imports("pkg/sub/c.py"), ["pkg/__init__.py", "pkg/b.py"]);
    assert.deepEqual(imports("main.py"), ["os", "pkg/b.py"]); // stdlib stays external
});

test("bare calls to from-imported names resolve inside the imported module", async () => {
    const d = mkdtempSync(join(tmpdir(), "grafly-pycall-"));
    const put = (rel, src) => { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), src); };
    put("pkg/__init__.py", "from .b import x\n");
    put("pkg/a.py", "def x():\n    return 'a'\n");
    put("pkg/b.py", "def x():\n    return 'b'\n");
    put("pkg/use_rel.py", "from .b import x\n\ndef go():\n    return x()\n");
    put("pkg/use_alias.py", "from pkg.a import x as ax\n\ndef go():\n    return ax()\n");
    put("pkg/use_mod.py", "import pkg.b as m\n\ndef go():\n    return m.x()\n");
    put("pkg/use_reexport.py", "from pkg import x\n\ndef go():\n    return x()\n");
    put("pkg/local.py", "from .b import x\n\ndef x():\n    return 'local'\n\ndef go():\n    return x()\n");
    await buildGraph(d, {});
    const g = JSON.parse(readFileSync(join(d, ".grafly", ".graph", "wiring.json"), "utf8"));
    const calls = (src) => g.edges.filter((e) => e.relation === "calls" && e.source === src).map((e) => e.target).sort();
    assert.deepEqual(calls("pkg/use_rel.py#go"), ["pkg/b.py#x"]);
    assert.deepEqual(calls("pkg/use_alias.py#go"), ["pkg/a.py#x"]);
    assert.deepEqual(calls("pkg/use_mod.py#go"), ["pkg/b.py#x"]);
    // a same-file definition rebinds the name; the local def wins
    assert.deepEqual(calls("pkg/local.py#go"), ["pkg/local.py#x"]);
    // __init__ re-export: the module has no def, so no edge is invented
    assert.ok(!calls("pkg/use_reexport.py#go").includes("pkg/a.py#x"));
    // no import references are emitted for Python imported names
    assert.equal(g.edges.filter((e) => e.relation === "references" && e.source.startsWith("pkg/use_")).length, 0);
});
