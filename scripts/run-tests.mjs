import { existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(repoRoot, "test");
if (!existsSync(testDir)) { console.error(`✗ no test directory found in ${testDir}`); process.exit(1); }
const files = readdirSync(testDir).filter((f) => /\.test\.(?:mjs|js|ts)$/.test(f)).sort().map((f) => join(testDir, f));
if (files.length === 0) { console.error(`✗ no test files found in ${testDir}`); process.exit(1); }
const gitEnv={GIT_CONFIG_COUNT:"2",GIT_CONFIG_KEY_0:"commit.gpgsign",GIT_CONFIG_VALUE_0:"false",GIT_CONFIG_KEY_1:"tag.gpgsign",GIT_CONFIG_VALUE_1:"false"};
// User-level product settings must not change test defaults. Keep only the
// explicit external-runtime opt-ins; test fixtures set their own other flags.
const optIns=new Set(["GRAFLY_TEST_CODEX","GRAFLY_TEST_PYTHON","GRAFLY_TEST_MC_SOURCE"]);
const testEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>
    !/^(?:(?:GRAFLY|GRAFT|MC)_|CODEX_THREAD_ID$|CLAUDECODE$)/i.test(key)||optIns.has(key.toUpperCase())));
const hasTs=files.some((f)=>f.endsWith(".ts"));
const args=[...(hasTs?["--import","tsx"]:[]),"--test","--test-reporter=tap",...files];
// Fixtures must never feed observations into the user's enabled local learner.
const learningHome=mkdtempSync(join(tmpdir(),"grafly-test-learning-"));
let result;
try {
    result=spawnSync(process.execPath,args,{cwd:repoRoot,stdio:"inherit",windowsHide:true,
        env:{...testEnv,...gitEnv,HOME:learningHome,USERPROFILE:learningHome,APPDATA:join(learningHome,"Roaming"),
            LOCALAPPDATA:join(learningHome,"Local"),CODEX_HOME:join(learningHome,"codex"),CLAUDE_CONFIG_DIR:join(learningHome,"claude"),
            MC_LEARNING_HOME:learningHome,MC_MODEL_HOME:join(learningHome,"consumer-models"),GRAFLY_JUDGMENT_CONFIG:"0"}});
} finally {
    rmSync(learningHome,{recursive:true,force:true});
}
if(result.error){console.error(`✗ could not start test runner: ${result.error.message}`);process.exit(1);}
process.exit(result.status??1);
