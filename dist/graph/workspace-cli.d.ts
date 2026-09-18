import type { EngineConfig } from "../ai/providers.js";
import type { Direction } from "./traverse.js";
export interface WorkspaceBuildOptions {
    deep: boolean;
    extensions?: string[];
    concurrency?: number;
    /** Provider/model/key config for child builds — WITHOUT any contextDir
     * override, so each child writes to its own `<child>/graft/`. */
    childConfig: EngineConfig;
    override?: string;
    /** The CLI's `--include-dir` override, if any. Persisted into EACH CHILD's
     * own state (not the parent's) before that child builds: children are
     * independent repos with their own local settings and can later be rebuilt
     * directly without seeing the parent invocation's flags. */
    includeDirs?: string[];
    /** An explicit CLI submodule choice to persist into every child repo. */
    followSubmodules?: boolean;
    /** An explicit CLI nested-clone choice to persist into every child repo. */
    followNestedRepos?: boolean;
}
/** Build every git child into its own committable `graft/`, then replace the
 * parent's `graft/` with `workspace.json`. Prints the one-time split warning
 * first when migrating away from a mega-graph. */
export declare function runWorkspaceBuild(root: string, opts: WorkspaceBuildOptions): Promise<void>;
export declare function runWorkspaceAsk(root: string, override: string | undefined, query: string, opts: {
    limit?: number;
    source?: boolean;
    full?: boolean;
    in?: string;
    json?: boolean;
}): void;
export declare function runWorkspaceGrep(root: string, override: string | undefined, pattern: string, opts: {
    ignoreCase?: boolean;
    fixed?: boolean;
    json?: boolean;
}): void;
export declare function runWorkspaceMap(root: string, override: string | undefined, opts: {
    maxDirs?: number;
}): void;
export declare function runWorkspaceCheck(root: string, override?: string): Promise<void>;
export declare function runWorkspaceCallers(root: string, override: string | undefined, symbol: string, opts: {
    direction?: Direction;
    depth?: number;
    in?: string;
}): void;
//# sourceMappingURL=workspace-cli.d.ts.map