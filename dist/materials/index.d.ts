import type { GraphV1 } from "../graph/types.js";
import type { ChatModel } from "../ai/llm/types.js";
import type { VizNode, VizEdge } from "../viz/assemble.js";
export interface MaterialReference {
    target: string;
    pointer: string;
    relation: "mentions";
    confidence: "path" | "exact-name" | "vision";
    evidence: string;
}
export interface MaterialChunk {
    id: string;
    pointer: string;
    page?: number;
    line?: number;
    method: "text" | "pdf-text" | "vision";
    text: string;
    references: MaterialReference[];
}
export interface MaterialFile {
    path: string;
    hash: string;
    size: number;
    mtimeMs: number;
    kind: "document" | "pdf" | "image";
    status: "ready" | "pending" | "partial" | "error";
    chunks: MaterialChunk[];
    model?: string;
    pages?: number;
    error?: string;
}
export interface MaterialStats {
    files: number;
    chunks: number;
    extracted: number;
    cached: number;
    links: number;
    pending: number;
    errors: string[];
}
export interface MaterialProvenance {
    id: string;
    path: string;
    hash: string;
    method: MaterialChunk["method"] | "metadata";
    status: MaterialFile["status"];
    model?: string;
    page?: number;
}
export declare function materialsPath(outDir: string): string;
export declare function readMaterials(outDir: string): { version: number; files: MaterialFile[] } | undefined;
export declare function listMaterialStats(root: string, outDir: string, repoFiles?: string[], onlyDirs?: ReadonlySet<string>): Array<{ abs: string; rel: string; size: number; mtimeMs: number }>;
export declare function probeMaterialDrift(root: string, outDir: string, onlyDirs?: ReadonlySet<string>, alwaysHash?: boolean): { added: string[]; changed: string[]; removed: string[] } | null;
export declare function buildMaterials(root: string, outDir: string, repoFiles: string[], graph: GraphV1, opts?: { vision?: ChatModel }): Promise<MaterialStats>;
export declare function materialConcepts(outDir: string): Array<{
    slug: string; name: string; kind: "document" | "image"; sources: string[]; pointer: string;
    snippet: string; text: string; related: string[]; references: MaterialReference[];
    extractedText: string; material: MaterialProvenance;
}>;
export declare function materialViz(outDir: string): { nodes: VizNode[]; edges: VizEdge[] };
