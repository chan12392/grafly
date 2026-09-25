import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

try {
  if (process.env.CI) process.exit(0);
  // The Devin/Codex hooks are user-level and index whatever folder a session
  // opens, so a first install wires them immediately instead of waiting for a
  // per-repo `grafly init`. Each no-ops when its host config dir is absent;
  // GRAFLY_NO_HOOK_INSTALL opts out of both.
  if (!process.env.GRAFLY_NO_HOOK_INSTALL) {
    const { installDevinHooks } = await import("../dist/hosts/devin-hooks.js");
    const { installCodexHooks } = await import("../dist/hosts/codex-hooks.js");
    const [devin, codex] = [installDevinHooks(), installCodexHooks(homedir())];
    if (devin.some((r) => r.action && r.action !== "unchanged"))
      console.log("\n  Grafly: Devin hooks installed.\n");
    if (codex.some((r) => r.action && r.action !== "unchanged"))
      console.log("\n  Grafly: Codex hooks installed.\n");
  }
  const dir = process.env.INIT_CWD || process.cwd();
  if (existsSync(join(dir, ".claude", "helpers", "grafly-statusline.cjs")) ||
      existsSync(join(dir, ".claude", "helpers", "graft-statusline.cjs"))) process.exit(0);
  console.log("\n  Grafly installed. Run `npx grafly init` to enable agent integration.\n");
} catch {
  // postinstall must never fail an installation
}
