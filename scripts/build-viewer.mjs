/**
 * Legacy viewer build, retained only as provenance. This dist-level checkout
 * ships the prebuilt dist/viewer assets; its original viewer/src inputs are
 * absent. This script is excluded from npm packages and is not a build step.
 */
import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const inputs = ["viewer/main.ts", "viewer/index.html", "viewer/style.css", "src/graph/queries"];
if (inputs.some((path) => !existsSync(join(root, path)))) {
  console.error("Legacy viewer build is unavailable: original viewer/src inputs are absent. Grafly uses the shipped dist/viewer assets; no rebuild is required.");
  process.exit(1);
}
// Restoring the original sources would also require their old build dependencies.
const { build } = await import("esbuild");
const outDir = join(root, "dist", "viewer");
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, "viewer", "main.ts")],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  outfile: join(outDir, "app.js"),
});

for (const asset of ["index.html", "style.css"]) {
  copyFileSync(join(root, "viewer", asset), join(outDir, asset));
}

console.log("viewer bundle → dist/viewer/");

// The generic (breadth) tier's tags.scm query files are runtime assets — tsc
// doesn't emit non-TS files, so copy them into dist so the published package
// (which ships `dist` only) can load them. generic.ts resolves dist/graph/queries
// first, then falls back to src/graph/queries for local dev.
const scmSrc = join(root, "src", "graph", "queries");
const scmOut = join(root, "dist", "graph", "queries");
mkdirSync(scmOut, { recursive: true });
let scmCount = 0;
for (const f of readdirSync(scmSrc)) {
  if (f.endsWith(".scm")) {
    copyFileSync(join(scmSrc, f), join(scmOut, f));
    scmCount++;
  }
}
console.log(`grammar queries → dist/graph/queries/ (${scmCount} .scm)`);
