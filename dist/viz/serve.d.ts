export interface VizServerOptions {
    contextDir: string;
    viewerDir: string;
    port: number;
    repoName: string;
}
export interface VizServer {
    url: string;
    close(): Promise<void>;
}
export declare function startVizServer(opts: VizServerOptions): Promise<VizServer>;
//# sourceMappingURL=serve.d.ts.map