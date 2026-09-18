export interface LspPosition {
    line: number;
    character: number;
}
export interface LspRange {
    start: LspPosition;
    end: LspPosition;
}
export interface CallHierarchyItem {
    name: string;
    kind: number;
    uri: string;
    range: LspRange;
    selectionRange: LspRange;
}
export declare class LspClient {
    private readonly root;
    private readonly languageId;
    private readonly callTimeoutMs;
    private proc;
    private conn;
    private opened;
    private ready;
    private spawnFailed;
    constructor(command: string, args: string[], root: string, languageId: string, callTimeoutMs?: number);
    /** Safe to write to the server's stdin right now? */
    private canWrite;
    /** A request with a timeout so a wedged server can't hang the whole build. */
    private call;
    initialize(): Promise<boolean>;
    /** Open a document (idempotent). Servers resolve cross-file refs from disk, but
     * the LSP spec wants the queried document opened first. */
    didOpen(abs: string): void;
    /** Poll one probe position until call-hierarchy returns something — servers
     * like rust-analyzer/clangd index AFTER `initialized` and answer empty until
     * ready. Returns true once ready (or false at the cap). */
    waitUntilReady(abs: string, pos: LspPosition, maxMs?: number): Promise<boolean>;
    prepareCallHierarchy(abs: string, pos: LspPosition): Promise<CallHierarchyItem[]>;
    /** The callees of an item — returns each outgoing call's `to` target. */
    outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyItem[]>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=client.d.ts.map