/** One already-ranked result and the file/partition whose output queue owns it. */
export interface FileFirstCandidate<T> {
    group: string;
    value: T;
}
/**
 * Project an existing ranking through file-first round-robin selection.
 *
 * The input MUST already be in baseline rank order. Map insertion order makes
 * the first pass exactly the baseline first-occurrence order of groups; later
 * passes expose additional spans only after every group has contributed its
 * leader. Concepts can participate without pretending to be source files by
 * receiving singleton group keys.
 *
 * Values are returned by identity and are never mutated.
 */
export declare function fileFirstRoundRobin<T>(ranked: readonly FileFirstCandidate<T>[], limit?: number): T[];
/** Project already-grouped queues directly. Unlike {@link fileFirstRoundRobin}
 * this does not flatten and rebuild a grouping map, so a file-aware ranker can
 * stop as soon as `limit` hits without materializing every tail span twice. */
export declare function roundRobinQueues<T>(queues: readonly (readonly T[])[], limit?: number): T[];
//# sourceMappingURL=file-selection.d.ts.map