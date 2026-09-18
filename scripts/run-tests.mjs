import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(repoRoot, "test");
if (!existsSync(testDir)) { console.error(`✗ no test directory found in ${testDir}`); process.exit(1); }
const files = readdirSync(testDir).filter((f) => /\.test\.(?:mjs|js|ts)$/.test(f)).sort().map((f) => join(testDir, f));
if (files.length === 0) { console.error(`✗ no test files found in ${testDir}`); process.exit(1); }
const gitEnv={GIT_CONFIG_COUNT:"2",GIT_CONFIG_KEY_0:"commit.gpgsign",GIT_CONFIG_VALUE_0:"false",GIT_CONFIG_KEY_1:"tag.gpgsign",GIT_CONFIG_VALUE_1:"false"};
const hasTs=files.some((f)=>f.endsWith(".ts"));
const args=[...(hasTs?["--import","tsx"]:[]),"--test",...files];
const result=spawnSync(process.execPath,args,{cwd:repoRoot,stdio:"inherit",env:{...process.env,...gitEnv}});
if(result.error){console.error(`✗ could not start test runner: ${result.error.message}`);process.exit(1);}
process.exit(result.status??1);
