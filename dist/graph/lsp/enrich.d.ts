import type { GraphV1 } from "../types.js";
export interface LspEnrichResult {
    added: number;
    queried: number;
    server: string | null;
}
export declare function enrichWithLsp(graph: GraphV1, root: string, opts?: {
    onProgress?: (done: number, total: number) => void;
    maxNodes?: number;
}): Promise<LspEnrichResult>;
//# sourceMappingURL=enrich.d.ts.map