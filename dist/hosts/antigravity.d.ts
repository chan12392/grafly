import type { PlannedWrite } from './plan.js';
import type { ConfigWrite } from './config-write.js';
/** The files installing Antigravity's global skill would touch — pure, no writes. */
export declare function antigravitySkillTargets(home: string): PlannedWrite[];
/** Write graft's skill into `~/.gemini/skills/graft/SKILL.md`, idempotently. */
export declare function installAntigravitySkill(home: string): ConfigWrite[];
//# sourceMappingURL=antigravity.d.ts.map