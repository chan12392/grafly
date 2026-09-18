import type { GraphV1 } from "./types.js";
/** Hidden subdir under the context dir that holds machine-only graph artifacts. */
export declare const GRAPH_DIR = ".graph";
export declare const GRAPH_FILE = "wiring.json";
/** Absolute path to the wiring graph for a context dir: `<dir>/.graph/wiring.json`. */
export declare function wiringPath(outDir: string): string;
/**
 * Read an existing wiring graph for use as the Tier-2 cache. Returns null when the
 * file is absent or unparseable (a fresh build, or a corrupt file we'll replace).
 */
export declare function readGraph(path: string): GraphV1 | null;
export declare function writeGraph(graph: GraphV1, outDir: string): string;
//# sourceMappingURL=write.d.ts.map