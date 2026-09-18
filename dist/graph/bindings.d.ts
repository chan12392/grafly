/**
 * Receiver-type binding pass: a pre-order walk over a parsed file that answers,
 * for every local variable / parameter / class field / `self`|`this` attribute,
 * "what type is this?" — so a later member-call site (`app.include_router()`)
 * can look up `app`'s bound type instead of resolving on the bare method name
 * alone. Pure and dependency-only: no LLM, no network, no mutation of the AST.
 *
 * Only `import type` from extract.ts (never a value) — extract.ts imports
 * `collectBindings` from here, so a value import back would be a cycle.
 */
import type Parser from "tree-sitter";
import type { Language, WalkCtx } from "./extract.js";
/** Variable/field → bare type name, keyed by scope. Scope keys mirror
 * extract.ts's own scope stack (`scope.join(".")`, `""` at module level) so a
 * lookup from extract.ts's walk finds exactly what was bound in the same
 * lexical position. */
export declare class FileBindings {
    private map;
    set(scopePath: string, name: string, type: string): void;
    /** Innermost-first: for scope ["a","b"] name "x", tries `a.b|x`, `a|x`, `|x`. */
    lookup(scope: string[], name: string): string | null;
}
/** Definition-node types that push a new scope segment, mirroring extract.ts's
 * `describe()` closely enough to keep the two scope stacks in lockstep — but
 * duplicated here (not imported) to keep bindings.ts free of a value import on
 * extract.ts. Returns the def's scope segment (bare name, except a Go method
 * which is receiver-qualified — `Receiver.method` — exactly like extract.ts's
 * `idName`, so a binding recorded inside a Go method body is stored under the
 * same scope key extract.ts's walk will look it up with), or null if `node`
 * isn't a definition. */
export declare function defName(node: Parser.SyntaxNode, lang: Language): string | null;
/**
 * The bare name a `binary_operator` (left-assign) or `function_definition`
 * (right-assign) node defines, for R's two plain-function assignment shapes —
 * this file's own `defName` uses it directly. extract.ts's `describeR`
 * duplicates the same op-filtering check rather than importing this (same
 * reasoning as the Go receiver helpers below: bindings.ts can't take a value
 * import back on extract.ts), and additionally needs to distinguish an S3
 * `generic.Class` method and R6/S4 class/method shapes this function doesn't
 * know about — bindings.ts has no equivalent need since no `handleR` binding
 * collector exists yet (R6/S4/S3 don't get a member/receiver-type table in
 * this pass; `self`/`private` resolve directly via `ctx.enclosingClass`
 * instead, needing no lookup). See `describeR`'s doc comment for why
 * right-assign's AST shape needs its own branch rather than mirroring
 * left-assign's (empirically, not assumed — `->`'s low precedence means it's
 * absorbed into the function's own `body` field, not an outer wrapper).
 * Null if `node` isn't one of these two shapes.
 */
export declare function rDefName(node: Parser.SyntaxNode): string | null;
/** The receiver parameter's own variable name for a Go method (`func (w *Worker) …`
 * → `w`). Null if it can't be read. */
export declare function goReceiverVarOf(node: Parser.SyntaxNode): string | null;
/** Resolves a call site's receiver text (from `calleeName`) to a bound type
 * name, given the enclosing walk state. `self`/`cls`/`this`/the Go receiver
 * var resolve directly to the enclosing class; `super` — R6's `super$` and
 * Swift's `super.` alike — resolves to the PARENT class instead
 * (`ctx.rSuperClass`, not `ctx.enclosingClass` — a super call must climb past
 * the current class's own same-named override, not find it); anything else is
 * a bindings-map lookup, normalizing `this.` to `self.` since both are stored
 * the same way. */
export declare function resolveRecvType(receiver: string | undefined, ctx: Pick<WalkCtx, "scope" | "enclosingClass" | "goReceiverVar" | "lang" | "bindings" | "rSuperClass">): string | undefined;
/** Pass 1 over a parsed file: collect variable->type bindings. Pure. */
export declare function collectBindings(root: Parser.SyntaxNode, lang: Language): FileBindings;
//# sourceMappingURL=bindings.d.ts.map