import type { PlannedWrite } from './plan.js';
import { type ConfigWrite } from './config-write.js';
/**
 * The files installing the Codex hook would touch — pure, no writes. Both live
 * under `~/.codex`, so both are scoped 'global': the hook entries fire in every
 * repo opened with Codex, not just this one. Empty when the CLI isn't installed,
 * mirroring `installCodexHooks`' early return.
 */
export declare function hookTargets(home: string): PlannedWrite[];
export declare function installCodexHooks(home: string): ConfigWrite[];
//# sourceMappingURL=codex-hooks.d.ts.map