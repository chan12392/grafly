import { type HostTarget } from '../hosts/registry.js';
import { type UpsertAction } from '../hosts/sections.js';
import type { BrainRule } from './link.js';
/** What a rules write did to one host's file. */
export interface BrainWrite {
    id: string;
    path: string;
    action: UpsertAction;
}
/**
 * Render the rules block for an instruction file.
 *
 * Grouped by the file the rule governs, because that is how someone reads a
 * codebase, and repo-wide rules (no symbol) come first — they apply everywhere,
 * so they should not be buried under a path heading.
 */
export declare function renderBrainSection(rules: BrainRule[], repoLabel: string): string;
/**
 * Every instruction file a brain section should go in.
 *
 * `section`-kind hosts only. An `owned`-kind host (Cursor's `.mdc`, Kiro's
 * steering file, a `SKILL.md`) is a file graft rewrites whole from a pure
 * template, so a second managed region inside one would be erased by the next
 * `init` — those agents get their rules through `graft ask` instead, which they
 * all call.
 *
 * Deduplicated by path: three hosts target `AGENTS.md`, and writing it three
 * times in one pass is just three identical upserts.
 */
export declare function brainSectionTargets(repo: string, home: string, ids?: string[]): HostTarget[];
/**
 * Write the brain's rules into each selected host's instruction file.
 *
 * Best-effort per file: one unwritable path must not stop the rest, since a
 * partially delivered rulebook is strictly better than none.
 */
export declare function writeBrainSections(repo: string, home: string, rules: BrainRule[], repoLabel: string, ids?: string[]): BrainWrite[];
