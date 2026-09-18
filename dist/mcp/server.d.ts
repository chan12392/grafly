/**
 * `version` is threaded in from the CLI rather than read here: `readCurrentVersion`
 * resolves package.json relative to the calling module, and from `dist/mcp/` that
 * lookup misses. The caller already knows it.
 */
export declare function startMcpServer(root: string, dirOverride?: string, version?: string): void;
//# sourceMappingURL=server.d.ts.map