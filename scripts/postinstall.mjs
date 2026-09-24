import { existsSync } from "node:fs";
import { join } from "node:path";

try {
  if (process.env.CI) process.exit(0);
  // Devin's hook is user-level and indexes whatever folder a session opens, so
  // a first install wires it immediately instead of waiting for a per-repo
  // `grafly init`. No-op when no Devin config dir exists; GRAFLY_NO_HOOK_INSTALL
  // opts out.
  if (!process.env.GRAFLY_NO_HOOK_INSTALL) {
    const { installDevinHooks } = await import("../dist/hosts/devin-hooks.js");
    if (installDevinHooks().some((r) => r.action && r.action !== "unchanged"))
      console.log("\n  Grafly: Devin hooks installed.\n");
  }
  const dir = process.env.INIT_CWD || process.cwd();
  if (existsSync(join(dir, ".claude", "helpers", "grafly-statusline.cjs")) ||
      existsSync(join(dir, ".claude", "helpers", "graft-statusline.cjs"))) process.exit(0);
  console.log("\n  Grafly installed. Run `npx grafly init` to enable agent integration.\n");
} catch {
  // postinstall must never fail an installation
}
