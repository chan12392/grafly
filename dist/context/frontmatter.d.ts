import type matter from "gray-matter";
/** Parse YAML/JSON concept metadata without dispatching executable engines. */
export declare function parseFrontmatter(content: string): matter.GrayMatterFile<string>;
