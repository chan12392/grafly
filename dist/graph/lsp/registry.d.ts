export interface LspServer {
    /** graft language names (as produced by languageLabelOf/genericLangOf) this serves. */
    languages: string[];
    command: string;
    args: string[];
    /** the LSP `languageId` to tag opened documents with. */
    languageId: string;
}
/** First-match-wins; ordering is priority. Extend by adding a row. */
export declare const LSP_SERVERS: readonly LspServer[];
/** Pick the highest-priority installed server that covers at least one of the
 * languages present in the repo, with `command` resolved to an absolute path.
 * Returns null if none is installed. */
export declare function pickServer(languagesPresent: Set<string>): LspServer | null;
//# sourceMappingURL=registry.d.ts.map