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
    put("util.py", "def join(*a):\n    return a\n");
    put("pkg/use_ext.py", "from os.path import join as pjoin\n\ndef go():\n    return pjoin('a')\n");
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
    // an aliased name from an external module never binds to a same-named repo def
    assert.deepEqual(calls("pkg/use_ext.py#go"), []);
    // no import references are emitted for Python imported names
    assert.equal(g.edges.filter((e) => e.relation === "references" && e.source.startsWith("pkg/use_")).length, 0);
});

test("member calls on a from-imported submodule resolve to that module only", async () => {
    const d = mkdtempSync(join(tmpdir(), "grafly-pyfrommod-"));
    const put = (rel, src) => { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), src); };
    put("src/__init__.py", "");
    put("src/billing/__init__.py", "");
    put("src/billing/invoice.py", "def total(items):\n    return 1\n");
    put("src/payments/refund.py", "def total(lines):\n    return 2\n");
    put("src/jobs/monthly.py", "from src.billing import invoice\n\ndef run():\n    return invoice.total([])\n");
    put("src/billing/rel.py", "from . import invoice as inv\n\ndef run():\n    return inv.total([])\n");
    // `config` is a package attribute, not a module file: no edge is guessed.
    put("src/jobs/attr.py", "from src.billing import config\n\ndef run():\n    return config.total([])\n");
    put("src/jobs/ext.py", "from os import path\n\ndef run():\n    return path.join('a')\n");
    put("util.py", "def join(*a):\n    return a\n");
    await buildGraph(d, {});
    const g = JSON.parse(readFileSync(join(d, ".grafly", ".graph", "wiring.json"), "utf8"));
    const calls = (src) => g.edges.filter((e) => e.relation === "calls" && e.source === src).map((e) => e.target).sort();
    assert.deepEqual(calls("src/jobs/monthly.py#run"), ["src/billing/invoice.py#total"]);
    assert.deepEqual(calls("src/billing/rel.py#run"), ["src/billing/invoice.py#total"]);
    assert.deepEqual(calls("src/jobs/attr.py#run"), []);
    assert.deepEqual(calls("src/jobs/ext.py#run"), []);
});

test("a package __init__ that rebinds a submodule name leaves member calls unresolved", async () => {
    const d = mkdtempSync(join(tmpdir(), "grafly-pyinit-"));
    const put = (rel, src) => { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), src); };
    // `from p import x` reads p.x from __init__ first; p/x.py is not what x names here.
    put("p/__init__.py", "from . import alternate as x\n");
    put("p/alternate.py", "def total():\n    return 'alternate'\n");
    put("p/x.py", "def total():\n    return 'x'\n");
    put("q/__init__.py", "from . import alternate\nx = alternate\n");
    put("q/alternate.py", "def total():\n    return 'alternate'\n");
    put("q/x.py", "def total():\n    return 'x'\n");
    // Importing the same-named submodule in __init__ keeps p.x that submodule.
    put("r/__init__.py", "from . import x\nfrom .x import total\n");
    put("r/x.py", "def total():\n    return 'x'\n");
    put("use_p.py", "from p import x\n\ndef run():\n    return x.total()\n");
    put("use_q.py", "from q import x\n\ndef run():\n    return x.total()\n");
    put("use_r.py", "from r import x\n\ndef run():\n    return x.total()\n");
    // `import p.x` always loads the submodule itself.
    put("use_p_mod.py", "import p.x as m\n\ndef run():\n    return m.total()\n");
    await buildGraph(d, {});
    const g = JSON.parse(readFileSync(join(d, ".grafly", ".graph", "wiring.json"), "utf8"));
    const calls = (src) => g.edges.filter((e) => e.relation === "calls" && e.source === src).map((e) => e.target).sort();
    assert.deepEqual(calls("use_p.py#run"), []);
    assert.deepEqual(calls("use_q.py#run"), []);
    assert.deepEqual(calls("use_r.py#run"), ["r/x.py#total"]);
    assert.deepEqual(calls("use_p_mod.py#run"), ["p/x.py#total"]);
});

test("an annotation-only package __init__ declaration does not rebind the submodule name", async () => {
    const d = mkdtempSync(join(tmpdir(), "grafly-pyinit-ann-"));
    const put = (rel, src) => { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), src); };
    // `x: object` creates no package attribute, so `from p import x` still imports p/x.py.
    put("p/__init__.py", "x: object\n");
    put("p/x.py", "def total():\n    return 'x'\n");
    // An annotated assignment does bind the attribute; the submodule no longer wins.
    put("q/__init__.py", "x: object = None\n");
    put("q/x.py", "def total():\n    return 'x'\n");
    // A real alias/assignment still rebinds the name.
    put("r/__init__.py", "from . import alternate\nx = alternate\n");
    put("r/alternate.py", "def total():\n    return 'alternate'\n");
    put("r/x.py", "def total():\n    return 'x'\n");
    put("s/__init__.py", "from . import alternate as x\nx: object\n");
    put("s/alternate.py", "def total():\n    return 'alternate'\n");
    put("s/x.py", "def total():\n    return 'x'\n");
    for (const p of ["p", "q", "r", "s"])
        put(`use_${p}.py`, `from ${p} import x\n\ndef run():\n    return x.total()\n`);
    // Inside a function an annotation makes the name local, so it still masks the import.
    put("use_local.py", "from p import x\n\ndef run():\n    x: object\n    return x.total()\n");
    await buildGraph(d, {});
    const g = JSON.parse(readFileSync(join(d, ".grafly", ".graph", "wiring.json"), "utf8"));
    const calls = (src) => g.edges.filter((e) => e.relation === "calls" && e.source === src).map((e) => e.target).sort();
    assert.deepEqual(calls("use_p.py#run"), ["p/x.py#total"]);
    assert.deepEqual(calls("use_q.py#run"), []);
    assert.deepEqual(calls("use_r.py#run"), []);
    assert.deepEqual(calls("use_s.py#run"), []);
    assert.deepEqual(calls("use_local.py#run"), []);
});

test("function-local bindings shadow a from-imported name; lazy imports rebind it", async () => {
    const d = mkdtempSync(join(tmpdir(), "grafly-pyshadow-"));
    const put = (rel, src) => { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), src); };
    // `foo` is ambiguous repo-wide, so only an import specifier can pick b.py or c.py
    put("b.py", "def foo():\n    return 'b'\n");
    put("c.py", "def foo():\n    return 'c'\n");
    put("use.py", [
        "from b import foo",
        "",
        "def plain():\n    return foo()",
        "def param(foo):\n    return foo()",
        "def assigned():\n    foo = print\n    return foo()",
        "def nested():\n    def foo():\n        return 1\n    return foo()",
        "def outer(foo):\n    def inner():\n        return foo()\n    return inner",
        "def lazy():\n    from c import foo\n    return foo()",
        "def rebinds_global():\n    global foo\n    foo = print\n    return foo()",
        "def sibling_param():\n    def helper(foo):\n        return foo\n    return foo()",
        "class K:\n    foo = print\n    def method(self):\n        return foo()",
        "",
    ].join("\n"));
    await buildGraph(d, {});
    const g = JSON.parse(readFileSync(join(d, ".grafly", ".graph", "wiring.json"), "utf8"));
    const calls = (src) => g.edges.filter((e) => e.relation === "calls" && e.source === src).map((e) => e.target).sort();
    assert.deepEqual(calls("use.py#plain"), ["b.py#foo"]);
    assert.ok(!calls("use.py#param").includes("b.py#foo"), "parameter shadows the import");
    assert.ok(!calls("use.py#assigned").includes("b.py#foo"), "local assignment shadows the import");
    assert.ok(!calls("use.py#nested").includes("b.py#foo"), "nested def shadows the import");
    const inner = g.nodes.find((n) => n.name === "inner")?.id;
    assert.ok(inner && !calls(inner).includes("b.py#foo"), "enclosing parameter shadows the import");
    assert.deepEqual(calls("use.py#lazy"), ["c.py#foo"]);
    assert.ok(!calls("use.py#rebinds_global").includes("b.py#foo"), "global reassignment is not the import");
    // a nested function's own parameter does not leak into the enclosing scope
    assert.ok(calls("use.py#sibling_param").includes("b.py#foo"));
    // class attributes are not visible inside methods
    const method = g.nodes.find((n) => n.name === "method")?.id;
    assert.deepEqual(calls(method), ["b.py#foo"]);
});
