import type { PlannedWrite } from './plan.js';
import { type ConfigWrite } from './config-write.js';
/** Use the active Codex account, or the conventional home when unset. */
export declare function codexHomeDir(home?: string): string;
/**
 * Files installing the Codex hooks would touch — pure, no writes. Config lives
 * in the active Codex home; existing valid shared shims stay in the default home
 * to preserve command identities. All are scoped 'global' across repositories.
 * Empty when the active Codex directory is absent.
 */
export declare function hookTargets(home?: string): PlannedWrite[];
export declare function installCodexHooks(home?: string, options?: { apply?: boolean }): ConfigWrite[];
