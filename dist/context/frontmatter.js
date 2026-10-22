import matter from "gray-matter";

// Capture only data parsers; never mutate gray-matter's process-wide engines.
const parseYaml = matter.engines.yaml.parse;
const parseJson = JSON.parse;
export function parseFrontmatter(content) {
    // Engine options merge with defaults, so reject executable languages first.
    const input = content.replace(/^\uFEFF/, "");
    let language = "yaml";
    if (input.startsWith("---") && !input.startsWith("----"))
        language = matter.language(input.slice(3)).name || "yaml";
    const normalized = language.toLowerCase();
    if (!["yaml", "yml", "json"].includes(normalized))
        throw new Error(`Unsupported concept frontmatter language: ${language}`);
    // Explicit options bypass the shared cache; preserve gray-matter's single BOM strip.
    return matter(content, { engines: {
        yaml: parseYaml,
        [language]: normalized === "json" ? parseJson : parseYaml,
    } });
}
