/**
 * CLI wiring for `grafly blast` — the command a CI job runs on a pull request.
 *
 * Kept out of cli.ts (argument wiring only) so the diff → seeds → walk → render
 * chain stays unit-testable without shelling out, matching `graph/traverse-cli.ts`.
 */
import { resolve } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { loadGraphCached } from "../graph/load.js";
import { blastRadiusIn } from "./blast.js";
import { changedFiles, refExists } from "./diff.js";
import { markdownReport, mermaidDiagram, textReport } from "./render.js";
const DEFAULT_DEPTH = 2;
function resolveFormat(raw) {
    if (raw === undefined)
        return "text";
    if (raw === "text" || raw === "markdown" || raw === "mermaid" || raw === "json")
        return raw;
    console.error(`✗ --format must be text, markdown, mermaid or json, got "${raw}"`);
    process.exit(1);
}
/** Same grammar as `grafly callers --depth`, so the two commands stay learnable together. */
function resolveDepth(raw) {
    if (raw === undefined)
        return DEFAULT_DEPTH;
    if (/^(all|full|max)$/i.test(raw))
        return Number.POSITIVE_INFINITY;
    const d = Number(raw);
    if (!Number.isFinite(d) || d < 1) {
        console.error(`✗ --depth must be a positive number or "all", got "${raw}"`);
        process.exit(1);
    }
    return Math.floor(d);
}
export async function runBlastCommand(dir, opts) {
    const root = resolve(dir);
    const contextDir = contextDirFor(root, opts.globalDir);
    const format = resolveFormat(opts.format);
    const depth = resolveDepth(opts.depth);
    const graph = loadGraphCached(contextDir);
    if (!graph) {
        console.error(`✗ no graph found at ${contextDir} — run \`grafly build\` first`);
        process.exit(1);
    }
    // An unknown base is the most common CI misconfiguration by a distance: an
    // `actions/checkout` without `fetch-depth: 0` leaves the base branch absent, and
    // git's own message ("unknown revision or path not in the working tree") sends
    // people looking for a typo instead of the checkout depth.
    if (opts.base !== undefined && !refExists(root, opts.base)) {
        console.error(`✗ base ref "${opts.base}" is not in this checkout.\n` +
            "  In CI, fetch enough history for the merge base: actions/checkout with `fetch-depth: 0`.");
        process.exit(1);
    }
    const diff = changedFiles(root, opts.base);
    if (!diff) {
        console.error(`✗ could not read a diff in ${root} — is this a git repository?`);
        process.exit(1);
    }
    const report = blastRadiusIn(graph, contextDir, diff.files, diff.basis, depth);
    if (opts.name)
        await nameClusters(graph, report, contextDir);
    // After naming, never before: a reviewer's reason cites area LABELS, and the
    // naming pass is what gives an area its final one.
    if (opts.owners !== false) {
        const { attachOwners, diffAuthors, localIdentity } = await import("./owners.js");
        // Everyone who wrote a commit in this range, plus whatever the caller named.
        // The range is the reliable half: CI knows the author's login but almost never
        // their commit email, and the email is what git history is keyed on.
        //
        // With no --base there is no range — this is the local "what am I about to
        // push" case — so the local git identity stands in for it. Without that, the
        // one person certain to have written the change is the top name in its own
        // list of who to ask about it.
        const authors = opts.base === undefined ? localIdentity(root) : diffAuthors(root, opts.base);
        attachOwners(root, report, { exclude: [...authors, ...(opts.prAuthor ?? [])] });
    }
    if (format === "json") {
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    if (format === "mermaid") {
        const diagram = mermaidDiagram(report);
        // Exit 0 with a comment, not an error: "nothing depends on this diff" is a
        // legitimate answer, and a CI step must not fail on it.
        console.log(diagram ?? "%% no dependents to draw");
        return;
    }
    process.stdout.write(format === "markdown" ? markdownReport(report, { root }) : textReport(report));
}
/**
 * Name the clusters left on their symbol backstop, then report what it cost.
 *
 * The work lives in `name.js`; all this adds is the `--name:` prefix a CLI
 * note wants.
 */
async function nameClusters(graph, report, contextDir) {
    const { nameReport } = await import("./name.js");
    const { note } = await nameReport(graph, report, contextDir);
    if (note)
        console.error(`• --name: ${note}`);
}
