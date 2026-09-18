export interface DetectProbe {
    home: string;
    repo: string;
    dirExists(path: string): boolean;
}
export interface HostTarget {
    id: string;
    name: string;
    kind: 'section' | 'owned';
    /** Target file, relative to the repo root. */
    relPath: string;
    content(): string;
    detect(probe: DetectProbe): boolean;
}
export declare const HOSTS: HostTarget[];
export declare function hostIds(): string[];
export declare function detectHosts(probe: DetectProbe): HostTarget[];
//# sourceMappingURL=registry.d.ts.map