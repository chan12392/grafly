import { type FileBindings } from "./bindings.js";
import type { Kind, NodeV1, Relation } from "./types.js";
export type Language = "typescript" | "tsx" | "python" | "go" | "java" | "kotlin" | "swift" | "php" | "r";
/** Every file extension a depth-tier (hand-written) extractor claims. */
export declare function depthExtensions(): string[];
/** Map a file path to a supported language, or null if unsupported. */
export declare function languageOf(path: string): Language | null;
/**
 * What to *call* the language of this file, for a banner or a repo map — or null when
 * the file isn't indexed at all, which is the distinction {@link languageOf} shares
 * and the one that matters to a reader checking coverage.
 */
export declare function languageLabelOf(path: string): string | null;
/**
 * An edge whose target isn't resolved yet. build.ts turns these into EdgeV1 by
 * matching `name`/`specifier` against the repo-wide node index.
 */
export interface RawEdge {
    source: string;
    relation: Relation;
    file: string;
    targetId?: string;
    specifier?: string;
    name?: string;
    viaMember?: boolean;
    /** calls with viaMember: the receiver's resolved type name (from bindings /
     * self / this / Go receiver), when a confident local clue exists. */
    recvType?: string;
    /** calls without viaMember: which kinds the bare-name match may resolve to.
     * Every other language's bare-name call is always a free function, so this
     * is absent for them (resolve.ts defaults to `["function"]`). R (Phase 4) is
     * the one exception: `obj$method()` with an untyped receiver (not
     * self/private/super, which already resolve precisely via viaMember+recvType)
     * still has a real shot at a correct match if the method name happens to be
     * uniquely defined across the repo — R6 methods are kind "method", not
     * "function", so without this override every such call would be
     * unconditionally unresolvable rather than just occasionally ambiguous. */
    kinds?: Kind[];
    /** calls: the number of arguments at the CALL SITE. Only emitted for languages
     * with overloading (Java, Swift), where a same-named sibling on the same class is
     * otherwise indistinguishable — and picking wrong turns a delegating overload
     * into a self-loop. */
    argCount?: number;
    /** Swift only: a bare lowercase call inside a type body, which the language
     * resolves member-first (inner scope wins). The edge carries the member
     * reading (viaMember + recvType = the enclosing type); this flag lets
     * resolve.ts fall back to the free-function reading when the owner chain has
     * no such member — and ONLY then, so a name defined as both a member and a
     * free function yields the member edge alone, exactly as Swift dispatches it. */
    implicitSelf?: boolean;
}
export interface ExtractResult {
    nodes: NodeV1[];
    rawEdges: RawEdge[];
}
export interface WalkCtx {
    rel: string;
    source: string;
    lang: Language;
    kinds: Record<string, Kind>;
    scope: string[];
    enclosingKind: Kind | null;
    parentId: string;
    bindings: FileBindings;
    enclosingClass: string | null;
    goReceiverVar: string | null;
    importedSymbols: ReadonlyMap<string, {
        name: string;
        specifier: string;
    }>;
    rR6Access: "public" | "private" | "active" | null;
    rGenerics: ReadonlySet<string>;
    rSuperClass: string | null;
}
export declare function extractFile(rel: string, source: string, lang: Language): ExtractResult;
/** Mint-time uniqueness: a document-order duplicate (same name reopened, or two
 * sibling defs that happen to collide) gets `~2`, `~3`, ... instead of silently
 * shadowing the first. The while-loop (not a single `~2` guess) is what makes
 * this collision-proof: a source name that itself ends in ~N would collide
 * with a single-guess suffix, so this keeps incrementing until it finds a
 * truly free id rather than trusting one candidate suffix is unused. */
export declare function mintId(base: string, minted: Set<string>): string;
//# sourceMappingURL=extract.d.ts.map