import type { Stats } from "node:fs";
export declare function alive(pid: number): boolean;
export declare function smallJSON(path: string): any;
export declare function safeRoot(path: string): string;
export declare function sameFile(a: Stats, b: Stats): boolean;
export declare function lock(root: string): { owns(): boolean; release(): void } | null;
