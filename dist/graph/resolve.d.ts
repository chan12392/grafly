import type { EdgeV1, NodeV1 } from "./types.js";
import { type RawEdge } from "./extract.js";
/** A Go module discovered in the repo: its `module` path from `go.mod` and the repo
 * directory that `go.mod` lives in (posix, `.` for the repo root). A monorepo may hold
 * several — e.g. `backend/go.mod`, `tools/go.mod`. */
export interface GoModule {
    module: string;
    dir: string;
}
export interface ResolveOptions {
    /** The Go modules found in the repo. Enables mapping Go import package paths
     * (`example.com/app/pkg/util`) to the in-repo directory they name, relative to the
     * owning module's `go.mod` location. Empty/absent → Go imports stay external strings. */
    goModules?: GoModule[];
}
export declare function resolveEdges(nodes: NodeV1[], rawEdges: RawEdge[], opts?: ResolveOptions): EdgeV1[];
//# sourceMappingURL=resolve.d.ts.map