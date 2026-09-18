/**
 * Assembles the viz-facing JSON for the context graph: reads every `.md` node
 * file in a context dir (frontmatter = node + edges) and produces a single
 * `{meta, nodes, edges}` document the viewer can render directly.
 *
 * Design rules (see docs/superpowers/specs/2026-07-15-graft-viz-design.md):
 *  - relations are normalized into the closed verb vocabulary — vague LLM
 *    softeners map to the concrete verb they usually mean
 *  - edges whose target slug doesn't exist are dropped (LLM output can dangle)
 *  - a node file with unparseable frontmatter is skipped, never fatal
 *  - both drop counts are reported in `meta` so the UI can say so
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
/**
 * Legacy vague verbs → the concrete verb they usually mean. Keeps old
 * `.context/` folders readable without regeneration; the synthesizer itself
 * is constrained to the closed vocabulary going forward.
 */
export const NORMALIZE_RELATION = {
    influences: "configures",
    supports: "validates",
    defines: "validates",
    measures: "validates",
};
export function normalizeRelation(rel) {
    return NORMALIZE_RELATION[rel] ?? rel;
}
const GEN_START = "<!-- context:generated:start -->";
const GEN_END = "<!-- context:generated:end -->";
const SUMMARY_MAX = 500;
/** Pull the prose summary out of a node body's generated block. */
function extractSummary(body) {
    let text = body;
    const start = text.indexOf(GEN_START);
    const end = text.indexOf(GEN_END);
    if (start >= 0 && end > start)
        text = text.slice(start + GEN_START.length, end);
    // Keep only the Summary section if headings are present.
    const related = text.indexOf("## Related");
    if (related >= 0)
        text = text.slice(0, related);
    text = text.replace(/^##\s+Summary\s*$/m, "");
    text = text.trim();
    return text.length > SUMMARY_MAX ? text.slice(0, SUMMARY_MAX).trimEnd() + "…" : text;
}
/** Read a context dir and assemble the render-ready graph document. */
export function assembleContextGraph(contextDir) {
    const nodes = [];
    const rawEdges = [];
    let skippedFiles = 0;
    if (existsSync(contextDir)) {
        for (const entry of readdirSync(contextDir).sort()) {
            if (!entry.endsWith(".md"))
                continue;
            let parsed;
            try {
                parsed = matter(readFileSync(join(contextDir, entry), "utf8"));
            }
            catch {
                skippedFiles++;
                continue;
            }
            const fm = parsed.data;
            const id = String(fm.slug ?? entry.replace(/\.md$/, ""));
            const sources = Array.isArray(fm.sources) ? fm.sources : [];
            const links = Array.isArray(fm.links) ? fm.links : [];
            nodes.push({
                id,
                name: String(fm.name ?? id),
                type: String(fm.type ?? "concept"),
                summary: extractSummary(parsed.content),
                sources: sources.map((s) => s.path),
            });
            for (const link of links) {
                if (!link || typeof link.to !== "string")
                    continue;
                rawEdges.push({
                    source: id,
                    target: link.to,
                    relation: normalizeRelation(String(link.relation ?? "uses")),
                    ...(link.description ? { description: link.description } : {}),
                });
            }
        }
    }
    const known = new Set(nodes.map((n) => n.id));
    const edges = rawEdges.filter((e) => known.has(e.source) && known.has(e.target));
    return {
        meta: {
            nodeCount: nodes.length,
            edgeCount: edges.length,
            skippedFiles,
            droppedEdges: rawEdges.length - edges.length,
        },
        nodes,
        edges,
    };
}
//# sourceMappingURL=assemble.js.map