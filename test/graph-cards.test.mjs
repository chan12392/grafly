// Wiring cards: one card per source file, and pruning that tracks deletions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeCards } from "../dist/graph/cards.js";

const file = (path) => ({ id: path, name: path, kind: "file", path, span: "L1-L1" });
const fn = (path, name) => ({ id: `${path}#${name}`, name, kind: "function", path, span: "L1-L2" });

test("sources differing only by extension get separate cards", () => {
    const out = mkdtempSync(join(tmpdir(), "grafly-cards-"));
    const graph = { nodes: [file("src/foo.c"), fn("src/foo.c", "impl"), file("src/foo.h"), fn("src/foo.h", "decl"), file("src/bar.c")], edges: [] };
    const r = writeCards(graph, out);
    assert.deepEqual(r.files.map((f) => f.card), ["src/bar.md", "src/foo.c.md", "src/foo.h.md"]);
    assert.match(readFileSync(join(out, "src/foo.c.md"), "utf8"), /impl/);
    assert.match(readFileSync(join(out, "src/foo.h.md"), "utf8"), /decl/);
});

test("a root-level card is pruned once its source is gone; concept nodes stay", () => {
    const out = mkdtempSync(join(tmpdir(), "grafly-cards-"));
    writeFileSync(join(out, "concept.md"), "---\nslug: concept\nsources: []\n---\nBody.\n");
    writeFileSync(join(out, "mc-report.md"), "# MC 0.6 consumer report\n\nHand-placed note.\n");
    writeFileSync(join(out, "TODO.md"), "# TODO\n\n- fix the build\n");
    writeFileSync(join(out, "glossary.md"), "# glossary\n\n_No extracted symbols in this file._\nmore notes\n");
    writeCards({ nodes: [file("setup.py"), file("src/a.js")], edges: [] }, out);
    assert.ok(existsSync(join(out, "setup.md")));
    const r = writeCards({ nodes: [file("src/a.js")], edges: [] }, out);
    assert.equal(r.pruned, 1);
    assert.equal(existsSync(join(out, "setup.md")), false);
    assert.ok(existsSync(join(out, "concept.md")));
    for (const note of ["mc-report.md", "TODO.md", "glossary.md"])
        assert.ok(existsSync(join(out, note)), note);
});
