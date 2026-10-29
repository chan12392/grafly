// Breadth-tier import bindings: a call to an import-bound name must resolve
// inside the imported module only — never to a same-named symbol elsewhere.
// Mirrors the depth-tier fix (extract.ts's importedSymbols → specifier stamp)
// for the languages whose imports are nameable: rust/solidity/dart/scala/
// clojure/elixir/lua.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const CLI = join(process.cwd(), "dist", "cli.js");
const build = (d, files) => {
    for (const [rel, src] of Object.entries(files)) {
        const p = join(d, ...rel.split("/"));
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, src);
    }
    const b = spawnSync(process.execPath, [CLI, "build"], { cwd: d, encoding: "utf8" });
    assert.equal(b.status, 0, b.stderr);
};
const callers = (d, sym) => JSON.parse(
    spawnSync(process.execPath, [CLI, "callers", sym, "--json"], { cwd: d, encoding: "utf8" }).stdout);
const hitsFor = (json, id) =>
    json.matches.find((m) => m.symbol.id === id)?.hits.map((h) => h.id) ?? null;

test("generic tier: bare and qualified import-bound calls resolve in-module", () => {
    const d = mkdtempSync(join(tmpdir(), "grafly-gbind-"));
    build(d, {
        // rust: bare import + `as` alias + qualified `crate::` path — all pin
        // util.rs even though other.rs defines a same-named helper.
        "src/util.rs": "pub fn helper() -> i32 { 1 }\npub struct Thing;\nimpl Thing { pub fn make() -> i32 { 2 } }\n",
        "src/other.rs": "pub fn helper() -> i32 { 9 }\n",
        "src/lib.rs": "pub mod util;\npub mod other;\n",
        "src/main.rs": "use crate::util::helper;\nuse crate::util::Thing as T;\nfn main() { helper(); T::make(); crate::util::helper(); }\n",
        // solidity: `{mint as m}` bare + `* as U` namespace member call.
        "contracts/t.sol": "function mint() public returns (uint) { return 1; }\n",
        "contracts/u.sol": "function go() public returns (uint) { return 2; }\n",
        "contracts/a.sol": 'import {mint as m} from "./t.sol";\nimport * as U from "./u.sol";\ncontract A { function f() public { m(); U.go(); } }\n',
        // dart: `show` binds a bare name.
        "lib/u.dart": "int helper() => 1;\n",
        "lib/main.dart": "import 'u.dart' show helper;\nvoid main() { helper(); }\n",
        // scala: `import a.b.Obj.{helper => h}` rename → bare h().
        "src/a/b/Obj.scala": "object Obj { def helper(): Int = 1 }\n",
        "src/Main.scala": "import a.b.Obj.{helper => h}\nobject Main { def run(): Int = h() }\n",
        // clojure: :refer bare + :as qualified + fully-qualified ns call.
        "src/x/util.clj": "(ns x.util)\n(defn helper [] 1)\n",
        "src/y/deep.clj": "(ns y.deep)\n(defn run [] 2)\n",
        "src/app/core.clj": "(ns app.core (:require [x.util :refer [helper]] [y.deep :as d]))\n(defn main [] (helper) (d/run) (x.util/helper))\n",
        // elixir: `alias` qualifies `Bar.go()`.
        "lib/foo/bar.ex": "defmodule Foo.Bar do\n  def go(), do: 1\nend\n",
        "lib/main.ex": "alias Foo.Bar\ndefmodule Main do\n  def run() do\n    Bar.go()\n  end\nend\n",
        // lua: `require` qualifies `m.go()`.
        "mod.lua": "function go() return 1 end\n",
        "main.lua": 'local m = require("mod")\nlocal function f() m.go() end\n',
    });

    const helper = callers(d, "helper");
    assert.deepEqual(hitsFor(helper, "src/util.rs#helper"), ["src/main.rs#main"]);
    assert.deepEqual(hitsFor(helper, "src/other.rs#helper"), []); // pinned away — no false edge
    assert.deepEqual(hitsFor(helper, "lib/u.dart#helper"), ["lib/main.dart#main"]);
    assert.deepEqual(hitsFor(helper, "src/a/b/Obj.scala#helper"), ["src/Main.scala#run"]);
    assert.deepEqual(hitsFor(helper, "src/x/util.clj#helper"), ["src/app/core.clj#main"]);

    assert.deepEqual(hitsFor(callers(d, "mint"), "contracts/t.sol#mint"), ["contracts/a.sol#f"]);
    const go = callers(d, "go");
    assert.deepEqual(hitsFor(go, "contracts/u.sol#go"), ["contracts/a.sol#f"]);
    assert.deepEqual(hitsFor(go, "lib/foo/bar.ex#go"), ["lib/main.ex#run"]);
    assert.deepEqual(hitsFor(go, "mod.lua#go"), ["main.lua#f"]);
    assert.deepEqual(hitsFor(callers(d, "run"), "src/y/deep.clj#run"), ["src/app/core.clj#main"]);
    assert.deepEqual(hitsFor(callers(d, "make"), "src/util.rs#make"), ["src/main.rs#main"]);
});

test("generic tier: module-qualified calls pick the qualifier's module among same-named defs", () => {
    // Each caller file can see two same-named definitions; only the qualifier
    // (crate path / alias / required table) says which one is meant.
    const d = mkdtempSync(join(tmpdir(), "grafly-gqual-"));
    build(d, {
        "src/a.rs": "pub fn work() -> i32 { 1 }\n",
        "src/b.rs": "pub fn work() -> i32 { 2 }\n",
        "src/lib.rs": "pub mod a;\npub mod b;\n",
        "src/main.rs": "use crate::b;\nfn main() { crate::a::work(); }\n",
        "lib/p/one.ex": "defmodule P.One do\n  def work(), do: 1\nend\n",
        "lib/p/two.ex": "defmodule P.Two do\n  def work(), do: 2\nend\n",
        "lib/app.ex": "alias P.One\nalias P.Two\ndefmodule App do\n  def run() do\n    One.work()\n  end\nend\n",
        "m1.lua": "function work() return 1 end\n",
        "m2.lua": "function work() return 2 end\n",
        "main.lua": 'local x = require("m1")\nlocal y = require("m2")\nlocal function f() x.work() end\n',
    });
    const work = callers(d, "work");
    assert.deepEqual(hitsFor(work, "src/a.rs#work"), ["src/main.rs#main"]);
    assert.deepEqual(hitsFor(work, "src/b.rs#work"), []);
    assert.deepEqual(hitsFor(work, "lib/p/one.ex#work"), ["lib/app.ex#run"]);
    assert.deepEqual(hitsFor(work, "lib/p/two.ex#work"), []);
    assert.deepEqual(hitsFor(work, "m1.lua#work"), ["main.lua#f"]);
    assert.deepEqual(hitsFor(work, "m2.lua#work"), []);
});
