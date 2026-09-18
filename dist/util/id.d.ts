/** Generate a random unique id with a short type prefix, e.g. "node_ab12…". */
export declare function newId(prefix: string): string;
/** Stable content hash (sha256, hex) used for document dedup. */
export declare function contentHash(input: string): string;
/** Normalize a name/alias for case- and whitespace-insensitive matching. */
export declare function normalizeName(name: string): string;
//# sourceMappingURL=id.d.ts.map