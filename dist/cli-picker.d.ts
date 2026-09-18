import type { HostPlan, PlannedWrite } from './hosts/plan.js';
/** `/Users/me/.codex/x` → `~/.codex/x`, for display only. */
export declare function tilde(path: string, home: string): string;
/**
 * One-line summary of what selecting a host writes: repo-relative paths, then
 * a count for anything landing outside the repo — those are the writes users
 * can't see in `git status`, so they get named explicitly.
 */
export declare function describeWrites(writes: PlannedWrite[], repo: string, home: string, maxShown?: number): string;
export interface PickerRow {
    id: string;
    detected: boolean;
    summary: string;
    /** True when selecting this host writes outside the repo. */
    hasGlobal: boolean;
    /** Display name. Differs from the id only for setting rows, whose id is an
     *  internal marker the user should never see. */
    label: string;
    /** `host` rows wire an agent; `setting` rows are choices that write no files.
     *  They render below a rule, and `a` (toggle all) leaves them alone — that key
     *  means "every agent", not "flip my privacy choice too". */
    kind: 'host' | 'setting';
}
/**
 * The id of the telemetry consent row.
 *
 * The picker is where a user is already deciding what graft may touch, which
 * makes it the honest place to also ask whether they mind anonymous usage stats
 * — the same move munder-difflin makes with a pre-checked box in onboarding, and
 * the reason this is a disclosed default rather than a silent one. It is only
 * offered when telemetry could actually run: showing it in a fork, in CI, or
 * under DO_NOT_TRACK would be theatre.
 */
export declare const TELEMETRY_ROW_ID = "__telemetry";
export interface PickerState {
    rows: PickerRow[];
    cursor: number;
    checked: ReadonlySet<string>;
    done: boolean;
    aborted: boolean;
}
/**
 * Claude Code starts checked — it's the deep integration — everything else off.
 *
 * `offerTelemetry` appends the consent row, checked. Default false so every
 * existing caller (and every test) sees exactly the host rows it always did.
 */
export declare function initialPickerState(plan: HostPlan[], repo: string, home: string, opts?: {
    offerTelemetry?: boolean;
}): PickerState;
export type PickerKey = 'up' | 'down' | 'space' | 'all' | 'enter' | 'abort';
export declare const KEY_UP = "\u001B[A";
export declare const KEY_DOWN = "\u001B[B";
export declare const KEY_ESC = "\u001B";
export declare const KEY_CTRL_C = "\u0003";
/** A single keypress → the key we act on, or null to ignore. */
export declare function keyOf(chunk: string): PickerKey | null;
/**
 * Split a raw stdin chunk into keypresses. A terminal is free to batch bytes —
 * held keys, pasted input, or a pty replaying a script all arrive as one chunk —
 * so a chunk is a sequence, never a single key. CSI sequences (ESC '[' final)
 * are consumed whole so an arrow key never reads as a bare ESC (i.e. abort).
 */
export declare function keysOf(chunk: string): PickerKey[];
export declare function reducePicker(state: PickerState, key: PickerKey): PickerState;
export declare function renderPicker(state: PickerState, tty?: boolean): string;
/** Ids in plan order, so output ordering never depends on toggle order. */
export declare function pickedIds(state: PickerState): string[];
/** Just the agents, with the setting rows filtered out — what init wires. */
export declare function pickedHostIds(state: PickerState): string[];
/** The consent answer, or undefined when the row was never offered (a fork, CI,
 *  DO_NOT_TRACK) — undefined means "don't change what's stored". */
export declare function pickedTelemetry(state: PickerState): boolean | undefined;
/**
 * Drive the picker on a real terminal. Resolves the chosen agents plus the
 * consent answer, or null if the user cancelled — in which case the caller must
 * write nothing, telemetry setting included.
 */
export interface Picked {
    /** Agent ids to wire. */
    hosts: string[];
    /** The consent answer, or undefined when the row was not offered. */
    telemetry?: boolean;
}
export declare function runPicker(plan: HostPlan[], repo: string, home: string, opts?: {
    offerTelemetry?: boolean;
}): Promise<Picked | null>;
/**
 * Shown when there's no TTY to prompt on and no flag saying what to wire.
 * Writing nothing is deliberate: a scripted run shouldn't get files for every
 * agent the machine happens to have installed.
 */
export declare function formatNonInteractiveHelp(detectedIds: string[]): string;
/**
 * `--dry-run` output: every path init would touch, repo writes first, then a
 * separate section for anything outside the repo.
 */
export declare function formatPlan(plan: HostPlan[], ids: string[], repo: string, home: string, tty?: boolean): string;
//# sourceMappingURL=cli-picker.d.ts.map