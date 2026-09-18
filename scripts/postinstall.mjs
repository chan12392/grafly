import { existsSync } from "node:fs";
import { join } from "node:path";

try {
  if (process.env.CI) process.exit(0);
  const dir = process.env.INIT_CWD || process.cwd();
  if (existsSync(join(dir, ".claude", "helpers", "grafly-statusline.cjs")) ||
      existsSync(join(dir, ".claude", "helpers", "graft-statusline.cjs"))) process.exit(0);
  console.log("\n  Grafly installed. Run `npx grafly init` to enable agent integration.\n");
} catch {
  // postinstall must never fail an installation
}
