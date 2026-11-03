/** Machine-global telemetry state. Shares `~/.graft/` with `update-check.json`. */
export interface TelemetryState {
    installId: string;
    /** The user's choice. Absent means "never chosen" → the default (on) applies. */
    enabled?: boolean;
    /** ISO stamp of the one-time first-run notice, so it prints exactly once. */
    noticeShownAt?: string;
    /** ISO stamp of the `first_run` event. Its own field rather than "did this
     *  call mint the install id", because the postinstall hook now mints the id
     *  before any command runs — see `trackFirstRunIfNew`. */
    firstRunAt?: string;
    /** The version the `install` event was last sent for, so an upgrade counts as
     *  an install and a repeated `npm install` of the same version does not. */
    installedVersion?: string;
    /** Epoch ms of the last flush ATTEMPT, mirroring `UpdateCache.checkedAt`. */
    flushedAt?: number;
}
export declare function statePath(home?: string): string;
export declare function readState(home?: string): TelemetryState | null;
/** Read-modify-write. Not atomic across processes; a lost update costs at most a
 *  duplicated notice or an extra flush attempt, never corruption. */
export declare function patchState(patch: Partial<TelemetryState>, home?: string): TelemetryState;
export interface Install {
    id: string;
    /** True when this call minted the id, i.e. this is the machine's first run. */
    firstRun: boolean;
}
/** The install id, minted on first call. */
export declare function installId(home?: string): Install;
/**
 * The repo id, in `graft/.cache/` rather than `.graft/config.json`.
 *
 * `.graft/config.json` would have been the tidier home, but writing it runs
 * `ensureBuildConfigIgnored`, which appends to the repo's `.gitignore`. Minting
 * an id during a read-only `graft ask` must not modify a file the user has
 * committed. `graft/.cache/` is already derived, already git-ignored, and
 * already where every other per-repo sidecar lives.
 */
export declare function repoId(repo: string): string;
