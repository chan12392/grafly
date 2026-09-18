/** True when dir is a Grafly root: built repository or workspace parent. */
export declare function hasGraflyIndex(dir: string): boolean;
export interface RootResolution {
    root: string;
    levels: number;
}
export declare function nearestGraflyRoot(start: string, override?: string): RootResolution;
/** @deprecated compatibility aliases. */
export declare const hasGraftIndex: typeof hasGraflyIndex;
export declare const nearestGraftRoot: typeof nearestGraflyRoot;
