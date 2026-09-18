export interface StoredPage {
    html: string;
    storedMs: number;
}
export interface PageStoreOptions {
    secret: string;
    ttlMs?: number;
    maxPages?: number;
    now?: () => number;
    /** Kept across restarts here. Absent: pages live only as long as the process. */
    dir?: string;
}
export declare class PageStore {
    private readonly pages;
    private readonly secret;
    private readonly ttlMs;
    private readonly maxPages;
    private readonly now;
    private readonly dir;
    constructor(opts: PageStoreOptions);
    /** `owner/repo#number` → a path segment safe to put in a URL. */
    static idFor(owner: string, repo: string, number: number): string;
    /** Store (replacing any previous page for the same PR) and return `id` + `token`. */
    put(owner: string, repo: string, number: number, html: string): {
        id: string;
        token: string;
    };
    /**
     * The page, if the token is valid and it has not expired.
     *
     * Expiry is checked against the STORED time rather than encoded in the token,
     * so a link cannot outlive the data it points at — and re-reviewing a PR
     * refreshes both together.
     *
     * Answered from memory even when there is a directory: `id` comes off a URL,
     * and an id that never reaches the filesystem cannot be walked out of it.
     */
    get(id: string, token: string | undefined): string | null;
    get size(): number;
    private sign;
    private valid;
    /** Oldest out first, plus anything past its TTL. */
    private evict;
    /** Take back what a previous process left on disk. */
    private hydrate;
    /** A stored page, or nothing: truncated, corrupt and gone are one answer here. */
    private read;
    /**
     * Temp file, then rename: a reader only ever sees a whole page, and two reviews
     * of the same pull request racing each other leave one of them intact rather
     * than the two interleaved.
     */
    private write;
    private remove;
}
//# sourceMappingURL=pages.d.ts.map