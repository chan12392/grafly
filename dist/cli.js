#!/usr/bin/env node
/**
 * `grafly` CLI. Commands: build, ask, check, callers, skeleton, grep,
 * map, init, migrate. The local graph cache lives under .grafly/. A
 * workspace parent (≥2 git children) federates query commands across children.
 */
import "dotenv/config";
import { Command } from "commander";
import { exitCommand } from "./util/cli-exit.js";
import { join, relative, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveConfig, ambientLlmConfig } from "./ai/providers.js";
import { buildGraphIfMissing, runInit } from "./claude/init.js";
import { statuslineWanted } from "./claude/settings-merge.js";
import { runHostsInit } from "./hosts/init.js";
import { hostIds } from "./hosts/registry.js";
import { brainStatus } from "./brain/connect.js";
import { configureLocalBrain, localBrainState, mineLocalBrain, scheduleLocalBrain } from "./brain/local.js";
import { anchoredRules } from "./brain/attach.js";
import { buildLocalDigest } from "./brain/push.js";
import { addRules, rewriteBrainSections } from "./brain/note.js";
import { contextDirFor } from "./context/node-file.js";
import { loadGraphCached } from "./graph/load.js";
import { isWorkspaceBuildRoot, readWorkspace } from "./graph/workspace.js";
import { nearestGraflyRoot } from "./graph/root.js";
import { discoverWorkspaceChildren } from "./graph/scopes.js";
import { formatInitEpilogue } from "./cli-epilogue.js";
import { planInit, selectedWrites } from "./hosts/plan.js";
import { planRetract, runRetract, changed } from "./hosts/retract.js";
import { formatNonInteractiveHelp, formatPlan, runPicker } from "./cli-picker.js";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { formatUpgradeReport, formatVersionReport, getNpmViewVersion, readCurrentVersion, runUpgrade } from "./cli-meta.js";
import { patchBuildConfig } from "./util/state.js";
import { normalizePathPrefix } from "./util/paths.js";
import { searchCommands, buildCommand, callersCommand, cliOptions } from "./search/commands.js";
import { latestSession, formatSessionStats, sessionInputRate } from "./claude/session-metrics.js";
import { setInputRate } from "./context/savings.js";
import { formatUpdateNudge, maybeRefreshInBackground, readUpdateCache, refreshUpdateCache, writeStamp } from "./upkeep.js";
import { errorCode, filesBucket, durationBucket, formatDebug, formatStatus, firstRunNotice, isTrackedCommand, langsValue, offReason, maybeFlushInBackground, patchState, runFlush, track, trackFirstRunIfNew, } from "./telemetry/index.js";
// Fresh option/telemetry state per invocation; imported modules and graph caches stay resident.
export function createCli() {
const program = new Command();
const currentVersion = readCurrentVersion(import.meta.url);
/**
 * What the `query` telemetry event will say, filled in by the command as it runs
 * and emitted once from the `postAction` hook below.
 *
 * An invocation-local slot rather than a threaded parameter because the repo root is
 * resolved deep inside each action (`queryRoot`) while the event is emitted
 * centrally — and because a command that calls `process.exit` should simply
 * report nothing, which falls out of never emitting until postAction.
 */
let queryNote = {};
/** Record the repo a query ran against, and pass it straight through so call
 *  sites stay one line. */
function noteQuery(dir) {
    queryNote.repo = dir;
    // Every retrieval command funnels through here, which makes it the one place
    // that can price this session's tokens before a formatter needs the number.
    setInputRate(sessionInputRate(dir));
    return dir;
}
/** Whether a query found anything. Only the commands that have a result count in
 *  hand call this; the property is simply absent for the others. */
function noteHit(found) {
    queryNote.hit = found ? "yes" : "no";
}
program
    .name("grafly")
    .description("Build a repo's context graph as linked markdown, and keep it in sync with the code.")
    .version(currentVersion, "-v, --version");
cliOptions(program);
/** Config drawn from the global CLI flags (env + defaults fill the rest). */
function cliConfig() {
    const o = program.opts();
    return {
        contextDir: o.dir,
        provider: o.provider,
        model: o.model,
        apiKey: o.apiKey,
        baseUrl: o.baseUrl,
    };
}
const engineFrom = async (overrides) => {
    const { Grafly } = await import("./engine.js");
    return new Grafly({ ...cliConfig(), ...overrides });
};
program.command('mc-analyzer [action]')
    .description('Configure or invoke the local MoreCoffee source-evidence analyzer')
    .option('--home <path>', 'trusted MoreCoffee installation')
    .option('--python <path>', 'absolute Python executable')
    .option('--root <path>', 'source repository to analyze')
    .option('--file <path>', 'query file relative to source root')
    .option('--candidate <path#symbol>', 'candidate definition (repeatable)', (value, previous) => [...previous, value], [])
    .action(async (action = 'status', opts) => {
        const { analyzerAction } = await import('./circuit/analyzer-cli.js');
        const result = analyzerAction(action, opts);
        console.log(JSON.stringify(result, null, 2));
        if (result.status === 'error' || result.out?.status === 'error') process.exitCode = 1;
    });
program.command('migrate-index [dir]')
    .description('Move a verified legacy index to .grafly, preserving settings and an original backup')
    .option('--dry-run', 'show the migration without writing')
    .action(async (dir = '.', opts) => {
        const { migrateIndex } = await import('./context/migrate-index.js');
        // Read-only plans the migration (the verified dry run) instead of moving anything.
        console.log(JSON.stringify(migrateIndex(resolve(dir), { dryRun: opts.dryRun || readOnlyMode() }), null, 2));
    });
program.command('deepidx [dir]')
    .description('Incremental Deep: refresh changed sources through the active Codex or Claude CLI')
    .option('--background', 'queue a durable background request')
    .option('--session <id>', 'deduplicate this session request')
    .option('--status', 'show the shared Deep queue and latest results')
    .action(async (dir = '.', opts) => {
        const { deepidx, autoDeepStatus } = await import('./hosts/auto-deep.js');
        const result = opts.status ? autoDeepStatus() : await deepidx(resolve(dir), { background: opts.background, sessionId: opts.session });
        console.log(JSON.stringify(result, null, 2));
        if (['failed', 'disabled', 'incomplete', 'busy'].includes(result.status)) process.exitCode = 1;
    });
/**
 * Warn (never fail) when a user's `-e` extension has no parser, so it is never a silent
 * no-op — `grafly build -e ".vue"` used to accept it, index nothing, and exit 0. The
 * supported set is listed so `-e` also answers "what is actually supported".
 */
async function warnUnsupportedExtensions(exts) {
    if (!exts?.length)
        return;
    const { unsupportedExtensions, supportedExtensions } = await import("./graph/source-files.js");
    const bad = unsupportedExtensions(exts);
    if (bad.length === 0)
        return;
    for (const e of bad) {
        const shown = e.trim().startsWith(".") ? e.trim() : `.${e.trim()}`;
        console.error(`⚠ -e "${shown}": no parser registered for this extension — ignoring it.`);
    }
    console.error(`  supported: ${supportedExtensions().join(" ")}`);
}
/** Text for the omitted-`[dir]` case, shared by every query command's help. */
const DIR_ARG = ["[dir]", "repository root (default: nearest ancestor with a .grafly/ index)"];
/**
 * The root a query runs against: the dir the user named, else the nearest
 * ancestor holding a graft index (`graph/root.ts`) so a shell or agent session
 * in a subdirectory still finds the graph. The walk is announced on stderr —
 * answering from an ancestor's graph must never be silent.
 */
function queryRoot(dir) {
    if (dir !== undefined)
        return resolve(dir);
    const { root, levels } = nearestGraflyRoot(process.cwd(), program.opts().dir);
    if (levels > 0)
        console.error(`[grafly] no .grafly/ here — answering from ${root}/.grafly`);
    return root;
}
/**
 * Bring the graph up to date with the working tree before a query answers from it
 * (see `graph/refresh.ts`). Cheap when nothing
 * moved; a structural, $0 rebuild when it did. The note goes to stderr so `--json`
 * stdout stays machine-readable.
 */
async function refreshBefore(dir, opts) {
    // GRAFLY_READONLY covers every query command, not only ask/grep.
    if (opts.refresh === false || process.env.GRAFLY_READONLY === "1")
        return;
    const { ensureFreshChildren, ensureFreshGraph, refreshNote } = await import("./graph/refresh.js");
    const globalDir = program.opts().dir;
    const root = resolve(dir);
    const ws = readWorkspace(root, globalDir);
    const r = ws
        ? await ensureFreshChildren(root, ws.children, { contextDir: globalDir })
        : await ensureFreshGraph(root, { contextDir: globalDir });
    const note = refreshNote(r);
    if (note)
        console.error(note);
}
/** Attached to every query command: `--no-refresh` answers from the graph exactly
 * as it is on disk, no rebuild. */
const NO_REFRESH_FLAG = ["--no-refresh", "skip the freshness check — answer from the graph as-is"];
/**
 * Commands that own the upgrade story themselves (`version`, `upgrade`) or are
 * the fetch itself (`_update-check`).
 */
const UPKEEP_SKIP = new Set(["version", "upgrade", "_update-check", "_brain-refresh", "_telemetry-flush", "_self-upgrade"]);
/**
 * Every other command: top up the cached registry answer in the background and,
 * if a newer Grafly is out, say so once on stderr. This is what makes the CLI the
 * cache filler for the hooks, which are not allowed to touch the network.
 */
/** `--read-only` (or GRAFLY_READONLY=1) promises that nothing is written, so a
 *  command whose purpose is a write refuses before it starts. Its read-only modes
 *  (`--status`, `--dry-run`, `--list-agents`, `status`, uninstall without -y) stay
 *  available; `migrate-index` plans instead. */
const READ_ONLY_WRITERS = new Set(["build", "deepidx", "init", "uninstall", "migrate", "hooks", "output-hook",
    "output-prune", "upgrade", "_self-upgrade", "_brain-refresh", "feedback"]);
function writesUnderReadOnly(action) {
    const name = action.name(), parent = action.parent?.name(), opts = action.opts();
    if (parent === "brain")
        return name === "digest" ? !!opts.out : name !== "status";
    if (parent === "xerj")
        return name !== "status";
    if (name === "telemetry")
        return ["enable", "disable"].includes(action.args[0]);
    if (name === "mc-analyzer")
        return action.args[0] === "configure";
    if (name === "deepidx" && opts.status)
        return false;
    if (["hooks", "output-prune", "init", "migrate"].includes(name) && opts.dryRun)
        return false;
    if (name === "init" && opts.listAgents)
        return false;
    // Without -y, uninstall only prints what it would remove.
    if (name === "uninstall" && !opts.yes)
        return false;
    return READ_ONLY_WRITERS.has(name);
}
const readOnlyMode = () => program.opts().readOnly === true || process.env.GRAFLY_READONLY === "1";
program.hook("preAction", (_parent, action) => {
    if (readOnlyMode() && writesUnderReadOnly(action)) {
        const name = action.parent && action.parent !== program ? `${action.parent.name()} ${action.name()}` : action.name();
        console.error(`✗ grafly ${name} writes files; refused under --read-only (GRAFLY_READONLY=1).`);
        exitCommand(1);
    }
    if (UPKEEP_SKIP.has(action.name()))
        return;
    maybeRefreshInBackground();
    const nudge = formatUpdateNudge(currentVersion, readUpdateCache()?.latest);
    if (nudge)
        console.error(nudge);
    // Telemetry, in the order a user should experience it: disclose first, then
    // record, then (at most once a day, detached) send. Every step is a no-op in a
    // fork, in CI, under DO_NOT_TRACK, or after `grafly telemetry disable`.
    const notice = firstRunNotice();
    if (notice)
        console.error(notice);
    trackFirstRunIfNew();
    maybeFlushInBackground();
});
/**
 * The `query` event, emitted after the command rather than before it, so it can
 * carry what the query actually did. A command that exits early via
 * `process.exit` never reaches here and is simply not counted — under-reporting
 * is the right failure mode for a metric.
 */
program.hook("postAction", (_parent, action) => {
    const name = action.name();
    if (!readOnlyMode() && queryNote.repo) scheduleLocalBrain(queryNote.repo);
    if (!isTrackedCommand(name))
        return;
    track("query", { command: name, surface: "cli", hit: queryNote.hit }, { repo: queryNote.repo });
});
// Hidden from --help: only ever spawned detached by maybeRefreshInBackground.
program
    .command("_brain-refresh", { hidden: true })
    .description("internal: mine rules locally in a background child")
    .argument("[dir]", "target repo directory", ".")
    .option("--job <id>", "scheduled job identity")
    .action(async (dir, opts) => {
        const result = await mineLocalBrain(resolve(dir), { background: true, jobId: opts.job });
        console.log(JSON.stringify(result));
        process.exitCode = result.exitCode ?? 0;
    });
program
    .command("_update-check", { hidden: true })
    .description("internal: refresh the cached latest-version answer")
    .action(() => {
    refreshUpdateCache();
});
// Hidden for the same reason as _update-check: only ever spawned detached, by
// maybeFlushInBackground. Running it by hand is harmless — it drains the queue.
program
    .command("_telemetry-flush", { hidden: true })
    .description("internal: POST the queued anonymous usage events")
    .action(async () => {
    await runFlush();
});
program
    .command("telemetry")
    .description("Show, inspect, or turn off the anonymous usage stats (see TELEMETRY.md)")
    .argument("[action]", "status (default) | enable | disable | debug", "status")
    .action((action) => {
    switch (action) {
        case "status":
            console.log(formatStatus());
            return;
        case "enable":
            patchState({ enabled: true });
            console.log("telemetry: on — anonymous, aggregate-only. `grafly telemetry status` for details.");
            return;
        case "disable":
            // Also stamp the notice as shown: someone who has just opted out should
            // not be told about telemetry again the next time they run a command.
            patchState({ enabled: false, noticeShownAt: new Date().toISOString() });
            console.log("telemetry: off. Nothing further will be recorded or sent.");
            return;
        case "debug":
            console.log(formatDebug());
            return;
        default:
            console.error(`✗ unknown action "${action}" — expected status, enable, disable, or debug`);
            exitCommand(1);
    }
});
program
    .command("version")
    .description("Print the installed version and the latest published on npm")
    .action(() => {
    const latest = getNpmViewVersion();
    console.log(formatVersionReport(currentVersion, latest));
});
/** Reconcile the user-level Devin, Codex and Claude Code hooks with this install's
 * defaults. Claude Code is reconciled only where it is installed (`~/.claude`). */
async function reconcileUserHooks(home, opts) {
    const { installDevinHooks } = await import("./hosts/devin-hooks.js");
    const { installCodexHooks } = await import("./hosts/codex-hooks.js");
    const { installClaudeGlobal } = await import("./hosts/claude-global.js");
    const claude = existsSync(join(home, ".claude")) ? installClaudeGlobal(home, opts) : [];
    return [...installDevinHooks(home, opts), ...installCodexHooks(home, opts), ...claude];
}
program
    .command("upgrade")
    .description("Update Grafly — git pull for linked checkouts, npm -g when GRAFLY_NPM_PACKAGE is set")
    .action(async () => {
    const result = runUpgrade(import.meta.url);
    if (result.ran && result.ok) {
        // A git pull doesn't run npm's postinstall — reconcile hooks here so an
        // upgrade also lands the current wiring, and drift self-heals.
        await reconcileUserHooks(homedir());
    }
    console.log(formatUpgradeReport(result));
    if (result.ran && !result.ok)
        exitCommand(1);
});
// Hidden: spawned detached by the agent-hook shim's daily self-upgrade stamp.
// Pulls the linked checkout (a no-op when up to date) and reconciles hooks —
// this is what makes dropped hook registrations self-heal between sessions.
program
    .command("_self-upgrade", { hidden: true })
    .description("internal: pull the linked checkout and reconcile agent hooks")
    .action(async () => {
    try {
        const result = runUpgrade(import.meta.url);
        if (result.ran && !result.ok)
            return;
        await reconcileUserHooks(homedir());
    }
    catch {
        /* detached maintenance — the next session retries */
    }
});
buildCommand(program)
    .action(async (dir, opts, command) => {
    const buildStartedAt = Date.now();
    if (opts.gitignore === false)
        process.env.GRAFLY_NO_GITIGNORE = "1";
    if (opts.ignore === false)
        process.env.GRAFLY_NO_IGNORE = "1";
    const concurrency = opts.concurrency ? Math.max(1, Number(opts.concurrency)) : undefined;
    if (opts.concurrency && !Number.isFinite(concurrency)) {
        console.error(`✗ --concurrency must be a number, got "${opts.concurrency}"`);
        exitCommand(1);
    }
    await warnUnsupportedExtensions(opts.extensions);
    // Persisted BEFORE the build itself runs, so this invocation's walks (and
    // every later no-flag build / hooks refresh) see it identically — the
    // walkDir call sites read it from state, not from a threaded option.
    const buildConfigPatch = {};
    if (opts.includeDir && opts.includeDir.length > 0) {
        // --include-dir takes bare SKIP_DIRS-style directory NAMES (shouldSkipDir
        // compares a single path segment), never paths, and dot-dirs are never
        // overridable at all (see the option's own help text) — reject anything
        // else up front instead of silently persisting a value that can never
        // match a real directory name.
        for (const name of opts.includeDir) {
            if (name.startsWith(".")) {
                console.error(`✗ --include-dir "${name}": dot-directories are never overridable`);
                exitCommand(1);
            }
            if (name.includes("/") || name.includes("\\")) {
                console.error(`✗ --include-dir "${name}": expected a bare directory name, not a path`);
                exitCommand(1);
            }
        }
        buildConfigPatch.includeDirs = opts.includeDir;
    }
    // The whitelist is NOT persisted to `.graft/config.json`: it belongs with the
    // graph (the fingerprint records it at build time), never in the source repo,
    // so a `--only-dir` build leaves no trace under the repo being indexed.
    let onlyDirs;
    if (opts.onlyDir && opts.onlyDir.length > 0) {
        // --only-dir takes a repo-relative path prefix, normalized to the same
        // posix, no-`./`, no-trailing-slash form `--in` uses, so the prefix match
        // is exact. A prefix that normalizes to "" (a bare "/" or ".") is rejected:
        // it would mean "match nothing" or "match everything", neither of which is
        // a deliberate whitelist.
        const normalized = opts.onlyDir.map((p) => normalizePathPrefix(p)).filter((p) => p !== "");
        if (normalized.length === 0) {
            console.error("✗ --only-dir: expected a non-empty repo-relative path");
            exitCommand(1);
        }
        onlyDirs = normalized;
    }
    const followSubmodulesWasExplicit = command.getOptionValueSource("followSubmodules") === "cli";
    if (followSubmodulesWasExplicit && typeof opts.followSubmodules === "boolean") {
        buildConfigPatch.followSubmodules = opts.followSubmodules;
    }
    const followNestedReposWasExplicit = command.getOptionValueSource("followNestedRepos") === "cli";
    if (followNestedReposWasExplicit && typeof opts.followNestedRepos === "boolean") {
        buildConfigPatch.followNestedRepos = opts.followNestedRepos;
    }
    if (Object.keys(buildConfigPatch).length > 0) {
        patchBuildConfig(resolve(dir), buildConfigPatch);
    }
    const fmt = (o) => Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n} ${k}`)
        .join(", ");
    // Reuse the active terminal CLI for text-only Deep, keeping explicit API configuration.
    let deep = opts.deep;
    const resolved = resolveConfig(cliConfig());
    const { agentContext, AgentChatModel } = await import('./ai/llm/agent.js');
    const agent = deep && !opts.vision && !resolved.apiKey ? agentContext() : null;
    const ambient = !resolved.apiKey && (opts.vision || deep && !agent && process.env.GRAFLY_AMBIENT_URL) ? ambientLlmConfig() : null;
    const deepConfig = agent ? { chatModel: new AgentChatModel(agent) } : ambient;
    if (opts.vision && !resolved.apiKey && !ambient)
        throw new Error("--vision needs a vision-capable model. Set GRAFLY_API_KEY / GRAFLY_MODEL / GRAFLY_BASE_URL, or connect the local endpoint.");
    if (deep && !resolved.apiKey) {
        if (agent) {
            console.error(`· using terminal agent ${deepConfig.chatModel.label} (background CLI inference).`);
        }
        else if (ambient) {
            console.error(`· no API key — using local endpoint ${ambient.baseUrl} (model: ${ambient.model}).`);
        }
        else {
            deep = false;
            console.error("⚠ no active agent or API key — falling back to the structural build (no LLM summaries).\n" +
                "  Run from Codex or Claude, set GRAFLY_AGENT_HOST=codex|claude, or configure GRAFLY_API_KEY.");
        }
    }
    const engine = await engineFrom(deepConfig ?? undefined);
    if (deep && resolved.usedLegacyEnv) {
        console.error("⚠ using OPENROUTER_API_KEY (deprecated) — prefer GRAFLY_API_KEY + GRAFLY_BASE_URL.");
    }
    // Workspace parent: build each child into its OWN .grafly/ + a workspace index.
    const buildRoot = resolve(dir);
    const buildGlobalDir = program.opts().dir;
    if (isWorkspaceBuildRoot(buildRoot, buildGlobalDir)) {
        const { runWorkspaceBuild } = await import("./graph/workspace-cli.js");
        await runWorkspaceBuild(buildRoot, {
            deep: !!deep,
            vision: !!opts.vision,
            extensions: opts.extensions,
            concurrency,
            childConfig: { ...cliConfig(), ...deepConfig },
            override: buildGlobalDir,
            includeDirs: opts.includeDir,
            followSubmodules: followSubmodulesWasExplicit ? opts.followSubmodules : undefined,
            followNestedRepos: followNestedReposWasExplicit ? opts.followNestedRepos : undefined,
        });
        return;
    }
    // --deep: concept nodes first, then the wiring graph links cards up to them.
    let conceptErrors = [];
    let conceptFatal;
    if (deep) {
        const c = await engine.init(dir, {
            extensions: opts.extensions,
            onlyDirs,
            concurrency,
            onProgress: ({ phase, index, total, file }) => process.stderr.write(`\r${phase === "summarize" ? "reading" : "writing"} concepts ${index + 1}/${total}: ${file.slice(0, 40).padEnd(40)}`),
        }).catch((err) => {
            // Only the stage and a code enum; the message stays on this machine.
            track("build_failed", { stage: "summarize", code: errorCode(err) }, { repo: buildRoot });
            throw err;
        });
        process.stderr.write("\n");
        console.log(`✓ concepts: ${c.nodes} nodes, ${c.links} links from ${c.files} files (${c.summarized} read, ${c.cached} cached)`);
        for (const e of c.errors)
            console.error(`✗ ${e}`);
        conceptErrors = c.errors;
        conceptFatal = c.fatal;
    }
    // Wiring graph — always; LLM meaning only with --deep.
    const g = await engine.graph(dir, {
        llm: deep,
        vision: !!opts.vision,
        extensions: opts.extensions,
        concurrency,
        reuse: opts.reuse,
        lsp: opts.lsp,
        onlyDirs,
        onProgress: ({ phase, index, total, file }) => process.stderr.write(`\r${phase === "enrich" ? "summarizing" : "parsing"} ${index + 1}/${total}: ${file.slice(0, 50).padEnd(50)}`),
    }).catch((err) => {
        track("build_failed", { stage: "graph", code: errorCode(err) }, { repo: buildRoot });
        throw err;
    });
    process.stderr.write("\n");
    const structuralFailed = g.structuralErrors > 0;
    if (structuralFailed)
        console.error(`✗ wiring incomplete: ${g.structuralErrors} structural error(s), ${g.nodes} nodes, ${g.edges} edges.`);
    else
        console.log(`✓ wiring: ${g.nodes} nodes (${fmt(g.byKind)}), ${g.edges} edges, ${g.cards} cards [${g.languages.join(", ")}]`);
    console.log(`  parsed: ${g.parsed} of ${g.files} files (${g.reused} replayed from cache)`);
    console.log(`  materials: ${g.materials.files} files, ${g.materials.chunks} excerpts, ${g.materials.links} code mentions (${g.materials.cached} cached)`);
    if (g.materials.pending)
        console.log(`  materials pending/partial: ${g.materials.pending}; use --vision for images/scanned pages; see the material status for extraction limits.`);
    if (g.materials.errors.length && !opts.allowPartial) process.exitCode = 1;
    // Worth one line: this build started from a graph the user never built *here*.
    if (g.seededFrom)
        console.log(`  seeded: copied a starting graph from ${g.seededFrom} (git worktree)`);
    if (deep) {
        const m = g.meaning;
        console.log(`  meaning: ${m.computed} computed, ${m.cached} cached, ${m.stale} stale, ${m.pending} pending`);
    }
    console.log(`  → ${g.contextDir}`);
    // The activation event. Everything here is a bucket or a fixed label: repo
    // scale rather than a file count, a language set rather than file names.
    if (!structuralFailed) track("build_completed", {
        files_bucket: filesBucket(g.files),
        langs: langsValue(g.languages),
        mode: deep ? "deep" : "fast",
        duration_bucket: durationBucket(Date.now() - buildStartedAt),
        incremental: String(g.reused > 0),
    }, { repo: buildRoot });
    if (structuralFailed) track("build_failed", { stage: "graph", code: "E_PARSE" }, { repo: buildRoot });
    for (const e of g.errors)
        console.error(`✗ ${e}`);
    if (g.nativeFallback)
        console.error(`⚠ ${g.nativeFallback.languages.join(", ")} using basic WASM parsing; reinstall with native build scripts enabled for ${g.nativeFallback.packages.join(", ")}.`);
    if (structuralFailed) exitCommand(1);
    const rel = relative(process.cwd(), g.contextDir) || ".grafly";
    if (process.env.GRAFLY_NO_GITIGNORE) {
        console.log(`  ${rel}/ is a local cache — add it to your gitignore if you want it untracked.`);
    }
    else {
        console.log(`  ${rel}/ is git-ignored (added automatically) — a local cache; teammates run \`grafly build\` to get their own.`);
    }
    // #127: a --deep run whose LLM calls failed used to print the same success
    // footer and exit 0, so a quota-exhausted build looked identical to a clean
    // one and `graft check` still said "in sync" (it only ever checked Tier-1).
    // The structural graph IS still written and every successful summary is
    // cached, so this is a loud warning about a degraded tier, not a rollback.
    if (deep) {
        const m = g.meaning;
        const failed = m.failedFiles > 0 || m.fatal !== undefined || conceptErrors.length > 0 || conceptFatal !== undefined;
        if (failed) {
            const ready = m.computed + m.cached;
            const total = ready + m.stale + m.pending;
            const pct = total > 0 ? Math.round((ready / total) * 100) : 0;
            console.error("");
            console.error(`✗ the deep pass did not complete — the meaning tier is incomplete.`);
            if (conceptFatal)
                console.error(`  concepts: ${conceptFatal}`);
            if (m.fatal)
                console.error(`  summaries: ${m.fatal}`);
            if (m.failedFiles > 0) {
                const skipped = m.skippedFiles > 0 ? `, ${m.skippedFiles} never attempted` : "";
                console.error(`  ${m.failedFiles} file(s) failed to summarize${skipped}.`);
            }
            if (conceptErrors.length > 0)
                console.error(`  ${conceptErrors.length} concept-pass error(s).`);
            console.error(`  meaning coverage: ${ready}/${total} symbols (${pct}%).`);
            console.error("  Nothing computed was lost: re-run `grafly build --deep` to resume from what is cached.\n" +
                "  Pass --allow-partial to accept a degraded meaning tier and exit 0.");
            if (!opts.allowPartial)
                process.exitCode = 1;
        }
    }
});
searchCommands(program, async (command, query, dirArg, opts) => {
    const { executeSearch } = await import("./search/request.js");
    const r = await executeSearch({ command, query, dir: dirArg, opts: { ...opts, contextDir: program.opts().dir } });
    noteQuery(r.root);
    if (r.hit !== undefined) noteHit(r.hit);
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exitCode = r.exitCode;
});
program.command("daemon").description("Manage the shared local search process")
    .argument("[action]", "start, status, stop or restart", "status")
    .action(async (action) => {
        const { daemonAction } = await import("./search/daemon.js");
        console.log(JSON.stringify(await daemonAction(action), null, 2));
    });
program.command("serve").description("Keep the Grafly CLI and embedded XERJ engine resident")
    .option("--stdio", "accept repeated JSON requests over stdin; one JSON response per line")
    .action(async (opts) => {
        const { serveSearch } = await import("./search/daemon.js");
        await serveSearch({ stdio: opts.stdio });
    });
const xerjCommand = program.command("xerj").description("Manage Grafly's embedded XERJ index or an explicit legacy server");
for (const action of ["connect", "sync", "status", "disconnect"]) {
    const cmd = xerjCommand.command(action);
    if (action === "connect") cmd.argument("<url>", "embedded or a loopback XERJ endpoint");
    cmd.argument(...DIR_ARG).action(async (...args) => {
        const dirArg = args[action === "connect" ? 1 : 0];
        const dir = queryRoot(dirArg);
        const outDir = contextDirFor(dir, program.opts().dir);
        const { syncXerj, xerjStatus, disconnectXerj } = await import("./search/xerj.js");
        try {
            if (action === "connect" || action === "sync") {
                if (readWorkspace(dir, program.opts().dir))
                    throw new Error("Connect XERJ at each indexed workspace child; the parent federates their results");
                const state = await syncXerj(dir, outDir, action === "connect" ? args[0] : undefined);
                if (!state) throw new Error("No XERJ backend connected; use grafly xerj connect <url>");
                console.log(JSON.stringify(xerjStatus(outDir), null, 2));
            }
            else if (action === "disconnect") {
                disconnectXerj(outDir);
                console.log("XERJ disconnected; Grafly uses builtin retrieval. Index data retained.");
            }
            else console.log(JSON.stringify(xerjStatus(outDir), null, 2));
        }
        catch (err) {
            console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
            process.exitCode = 1;
        }
    });
}
program
    .command("skeleton")
    .description("Signatures-only view of one file from the wiring graph — the cheapest way to see a file's API surface")
    .argument("<file>", "repo-relative path (or unique basename) of the file")
    .argument(...DIR_ARG)
    .option("--json", "output the result as JSON")
    .option(...NO_REFRESH_FLAG)
    .action(async (file, dirArg, opts) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const { skeleton, formatSkeleton } = await import("./ask/ask.js");
    const globalOpts = program.opts();
    const r = skeleton(dir, file, { contextDir: globalOpts.dir });
    if (opts.json)
        console.log(JSON.stringify(r, null, 2));
    else
        process.stdout.write(formatSkeleton(r));
});
program
    .command("check")
    .description("Fail if .grafly/ is stale relative to the code (for CI)")
    .argument(...DIR_ARG)
    .option("-e, --extensions <exts...>", "code extensions to include")
    .option("--json", "output the drift as JSON")
    .action(async (dirArg, opts) => {
    await warnUnsupportedExtensions(opts.extensions);
    const dir = noteQuery(queryRoot(dirArg));
    const checkGlobalDir = program.opts().dir;
    if (readWorkspace(dir, checkGlobalDir)) {
        const { runWorkspaceCheck } = await import("./graph/workspace-cli.js");
        await runWorkspaceCheck(dir, checkGlobalDir);
        return;
    }
    const engine = await engineFrom();
    const r = engine.check(dir, { extensions: opts.extensions });
    const g = await engine.checkGraph(dir); // graph.json is only judged when it exists
    const { formatCheckReport } = await import("./context/check.js");
    const { formatGraphCheckReport } = await import("./graph/check.js");
    // A layer that IS present must be in sync; a never-built layer (keyless
    // build skips the markdown layer) is informational, not a failure.
    const bothMissing = r.missing && g.missing;
    const markdownFail = !r.missing && !r.ok;
    const wiringFail = !g.missing && !g.ok;
    if (opts.json) {
        console.log(JSON.stringify({ context: r, graph: g.missing ? null : g }, null, 2));
    }
    else if (bothMissing) {
        console.log("grafly check: NO GRAPH\n\nNo .grafly/ graph found. Run `grafly build` first.");
    }
    else {
        if (r.missing) {
            console.log("deep layer: not built (run `grafly build --deep` for concept nodes) — wiring graph is the source of truth");
        }
        else {
            console.log(formatCheckReport(r));
        }
        if (!g.missing)
            console.log("\n" + formatGraphCheckReport(g));
    }
    if (bothMissing || markdownFail || wiringFail)
        exitCommand(1);
});
program
    .command("stats")
    .description("Show this agent session's grafly-vs-source usage mix and tokens saved")
    .argument(...DIR_ARG)
    .option("--json", "output the session stats as JSON")
    .action((dirArg, opts) => {
    // Reads local session JSON only — no graph, no network. This is how a Cursor
    // user (no statusline) sees the numbers the Claude Code bar would show, and it
    // works under DO_NOT_TRACK because it never touches telemetry.
    const dir = queryRoot(dirArg);
    const s = latestSession(dir);
    if (opts.json) {
        console.log(JSON.stringify(s, null, 2));
        return;
    }
    console.log(formatSessionStats(s));
});
callersCommand(program)
    .action(async (symbol, dirArg, opts) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const globalOpts = program.opts();
    if (readWorkspace(dir, globalOpts.dir)) {
        const { runWorkspaceCallers } = await import("./graph/workspace-cli.js");
        runWorkspaceCallers(dir, globalOpts.dir, symbol, {
            direction: opts.direction,
            depth: opts.depth,
            in: opts.in,
            top: opts.top,
            limit: opts.limit,
            json: opts.json,
        });
        return;
    }
    const { runCallersCommand } = await import("./graph/traverse-cli.js");
    runCallersCommand(symbol, dir, {
        direction: opts.direction,
        depth: opts.depth,
        in: opts.in,
        top: opts.top,
        limit: opts.limit,
        json: opts.json,
        globalDir: globalOpts.dir,
    });
});
program
    .command("blast")
    .description("Blast radius of a diff: what depends on the lines this change touched ($0, no LLM). " +
    "Built for CI — `--format markdown` is a PR comment with a Mermaid diagram.")
    .argument(...DIR_ARG)
    .option("--base <ref>", "diff against this ref's merge base with HEAD (e.g. origin/main); default: the working tree vs HEAD")
    .option("-d, --depth <n>", 'hops to walk over incoming edges, or "all" for the full closure (default 2)')
    .option("--format <fmt>", "text (default) | markdown | mermaid | json")
    .option("--name", "name the affected areas with one cached LLM call (needs GRAFLY_API_KEY); without it, areas are named after their hub symbol")
    .option("--no-owners", "do not suggest who to tag (by default, git history names the people behind each affected area)")
    .option("--pr-author <who...>", "GitHub login, git name or email of the PR author, so they are left out of their own suggestions")
    .option(...NO_REFRESH_FLAG)
    .action(async (dirArg, opts) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const { runBlastCommand } = await import("./blast/blast-cli.js");
    await runBlastCommand(dir, {
        base: opts.base,
        depth: opts.depth,
        format: opts.format,
        name: opts.name,
        owners: opts.owners,
        prAuthor: opts.prAuthor,
        globalDir: program.opts().dir,
    });
});
program
    .command("map")
    .description("Token-budgeted repo orientation — directory clusters, per-directory hubs, and global hotspots from the wiring graph ($0, no LLM)")
    .argument(...DIR_ARG)
    .option("--max-dirs <n>", "max directory entries shown, rest counted into dropped (default 16)")
    .option("--json", "output as JSON")
    .option(...NO_REFRESH_FLAG)
    .action(async (dirArg, opts) => {
    const dir = noteQuery(queryRoot(dirArg));
    const root = resolve(dir);
    const globalOpts = program.opts();
    let maxDirsW;
    if (opts.maxDirs !== undefined) {
        const n = parseInt(opts.maxDirs, 10);
        if (!Number.isFinite(n) || n <= 0) {
            console.error(`✗ --max-dirs must be a positive integer, got "${opts.maxDirs}"`);
            exitCommand(1);
        }
        maxDirsW = n;
    }
    await refreshBefore(dir, opts); // after arg validation: a bad flag shouldn't cost a rebuild
    if (!opts.json && readWorkspace(root, globalOpts.dir)) {
        const { runWorkspaceMap } = await import("./graph/workspace-cli.js");
        runWorkspaceMap(root, globalOpts.dir, { maxDirs: maxDirsW });
        return;
    }
    const { buildRepoMap, formatRepoMap } = await import("./graph/map.js");
    const contextDir = contextDirFor(root, globalOpts.dir);
    const graph = loadGraphCached(contextDir);
    if (!graph) {
        console.error("✗ no graph — run grafly build first");
        exitCommand(1);
    }
    const map = buildRepoMap(graph, { maxDirs: maxDirsW });
    if (opts.json) {
        console.log(JSON.stringify(map, null, 2));
        return;
    }
    process.stdout.write(formatRepoMap(map));
});
program
    .command("mc-runtime")
    .description("Inspect, sync or watch the signed Oracle MC runtime (requires trusted local enrollment)")
    .argument("[action]", "status, sync or watch", "status")
    .action(async (action) => {
        const { runtimeCLI } = await import("./mc-runtime/cli.js");
        await runtimeCLI(action);
    });
program
    .command("feedback")
    .description("Record a verified correct candidate (or abstain) for a logged judgment; never inferred from navigation")
    .argument("<jid>", "judgment ID printed by callers")
    .argument("<expected>", "exact correct candidate ID from callers --json, or abstain")
    .argument(...DIR_ARG)
    .requiredOption("--evidence <text>", "what was checked to establish the expected result")
    .action(async (jid, expected, dirArg, opts) => {
        const { circuitLogPath } = await import("./graph/traverse-cli.js");
        const { recordLabel } = await import("./circuit/feedback.js");
        const root = resolve(queryRoot(dirArg));
        console.log(JSON.stringify(recordLabel(circuitLogPath(contextDirFor(root, program.opts().dir)),
            root, jid, expected, opts.evidence), null, 2));
    });
program
    .command("run")
    .description("Run a command once; retain raw output and reduce recognized passing test details with MC")
    .argument("<command>")
    .argument("[args...]")
    .option("--session-id <id>", "request-bound identity for conditional reads")
    .allowUnknownOption()
    .action(async (command, args, opts) => {
        const { runCommand } = await import("./tool-output/runner.js");
        process.exitCode = (await runCommand(command, args, { sessionId: opts.sessionId })).exit_code;
    });
program
    .command("read")
    .description("Bounded file/directory read with path:line provenance (no command runs)")
    .argument("<path>", "file or directory")
    .option("--start <line>", "first line/entry, one-based", "1")
    .option("--count <lines>", "maximum lines/entries (default 200)")
    .option("--find <literal>", "find exact, case-sensitive text in the file")
    .option("--context <lines>", "surrounding lines for search (0..20; default 1)")
    .option("--max-matches <number>", "maximum matching lines (1..200; default 20)")
    .option("--max-bytes <number>", "byte budget (1024..1048576; search default 8192, range default 1048576)")
    .option("--fresh", "force a full read, ignoring the session's conditional-read cache")
    .option("--session-id <id>", "request-bound identity for conditional reads")
    .action(async (pathArg, opts) => {
        const { readPath } = await import("./tool-output/output.js");
        process.stdout.write(readPath(pathArg, opts));
    });
program
    .command("output")
    .description("Search verified command output, or read raw streams/ranges (stdout and stderr by default)")
    .argument("<id>")
    .option("--stream <name>", "stdout or stderr")
    .option("--start <line>", "first line, one-based", "1")
    .option("--count <lines>", "maximum number of lines")
    .option("--archive-dir <path>", "archive root (or GRAFLY_OUTPUT_DIR)")
    .option("--find <literal>", "find exact, case-sensitive text; return bounded matching lines")
    .option("--context <lines>", "surrounding lines for search (0..20; default 1)")
    .option("--max-matches <number>", "maximum matching lines across streams (1..200; default 20)")
    .option("--max-bytes <number>", "search response byte budget including metadata (1024..1048576; default 8192)")
    .action(async (id, opts) => {
        const { writeOutput } = await import("./tool-output/output.js");
        writeOutput(id, opts);
    });
program
    .command("output-prune")
    .description("Enforce the 20 MiB raw-output budget, protecting active writers")
    .option("--dry-run", "report eligible records without deleting them")
    .action(async (opts) => {
        const { pruneArchives } = await import("./tool-output/retention.js");
        console.log(JSON.stringify(pruneArchives({ dryRun: Boolean(opts.dryRun) }), null, 2));
    });
program
    .command("output-hook")
    .description("Install or remove Codex/Orca output-runner instructions (normal tool permissions retained)")
    .option("--home <path>", "Codex home (defaults to active CODEX_HOME)")
    .option("--remove", "remove only Grafly's output hook")
    .action(async (opts) => {
        const { installOutputHook } = await import("./tool-output/install.js");
        console.log(JSON.stringify(installOutputHook(opts.home, { remove: opts.remove }), null, 2));
    });
program
    .command("hooks")
    .description("Reconcile user-level agent hooks (Devin config.json, Codex hooks.json, Claude Code ~/.claude) with this install's defaults — drifted entries are rewritten, missing ones added")
    .option("--home <path>", "home directory to reconcile (defaults to the current user's)")
    .option("--dry-run", "report the actions reconciling would take without writing")
    .action(async (opts) => {
        const home = opts.home ? resolve(opts.home) : homedir();
        console.log(JSON.stringify(await reconcileUserHooks(home, { apply: !opts.dryRun }), null, 2));
    });
program
    .command("init")
    .description("Wire Grafly into the AI coding agents used with this repo (instruction files; full hooks + statusline for Claude Code)")
    .argument("[dir]", "target repo directory", ".")
    .option("--no-build", "skip building the graph (wire files only)")
    .option("--agents <ids...>", `only these agents (${hostIds().join(", ")}, claude)`)
    .option("--all-agents", "write instruction files for every known agent, detected or not")
    .option("--no-agents", "Claude Code wiring only; skip other agents")
    .option("--list-agents", "list known agent ids and exit")
    .option("--no-hooks", "skip hook installation for other agents")
    .option("--no-statusline", "skip writing Claude Code statusLine (keep a user-defined one)")
    .option("--dry-run", "print every file init would touch, then exit without writing")
    .option("-y, --yes", "skip the picker and wire every detected agent (the pre-0.8 default)")
    .option("--no-global", "skip writes outside this repo (the ~/.codex/ config + hooks)")
    .option("--brain <mode>", "enable local background mining (local)")
    .action(async (dir, opts) => {
    if (opts.listAgents) {
        for (const id of [...hostIds(), "claude"])
            console.log(id);
        return;
    }
    if (opts.brain && opts.brain !== "local") {
        console.error("✗ --brain now accepts local; remote Brain handoffs are retired.");
        process.exitCode = 1;
        return;
    }
    const repo = resolve(dir);
    const explicit = Array.isArray(opts.agents) ? opts.agents : undefined;
    if (explicit) {
        const validIds = [...hostIds(), "claude"];
        const unknown = explicit.filter((id) => !validIds.includes(id));
        if (unknown.length) {
            console.error(`✗ unknown agent id(s): ${unknown.join(", ")} — valid: ${validIds.join(", ")}`);
            exitCommand(1);
        }
    }
    // Which agents to wire, decided before anything is written. Explicit flags
    // win; otherwise prompt on a TTY, and on a pipe write nothing rather than
    // guessing (pre-0.8 this silently wired every agent the machine had ever
    // installed — see --yes to get that back).
    const home = homedir();
    const plan = planInit(repo, { home });
    const detectedIds = plan.filter((p) => p.detected).map((p) => p.id);
    const noAgents = opts.agents === false;
    let ids;
    // The consent answer from the picker. Undefined everywhere else — a scripted
    // or flag-driven init never asked, so it must not silently answer.
    let consent;
    if (explicit)
        ids = explicit;
    else if (opts.allAgents)
        ids = plan.map((p) => p.id);
    else if (noAgents)
        ids = ["claude"];
    else if (opts.yes || opts.dryRun)
        ids = detectedIds;
    else if (process.stdin.isTTY && process.stderr.isTTY) {
        // Only offer the row when telemetry could actually run. `disabled` still
        // counts: someone who turned it off should be able to turn it back on here.
        const reason = offReason();
        const picked = await runPicker(plan, repo, home, {
            offerTelemetry: reason === null || reason === "disabled",
        });
        if (picked === null) {
            console.error("· cancelled — nothing written");
            return;
        }
        ids = picked.hosts;
        consent = picked.telemetry;
    }
    else {
        console.error(formatNonInteractiveHelp(detectedIds));
        return;
    }
    // The picker's answer, recorded before anything is wired: a user who
    // unchecked the row must not have this run's init_completed sent.
    if (consent !== undefined) {
        patchState({ enabled: consent, noticeShownAt: new Date().toISOString() });
    }
    // Workspace parent: every child repo gets its OWN wiring too. A session
    // opens at a repo root, not at the parent, and reads `.claude/` from there —
    // wiring only the parent leaves each child with no skill or hooks.
    // The parent's own wiring stays (queries there federate across children).
    const children = isWorkspaceBuildRoot(repo, program.opts().dir)
        ? discoverWorkspaceChildren(repo)
        : [];
    // Parent FIRST: its build is the workspace build, which builds every child's
    // graph, so each child's own `buildGraphIfMissing` then finds one and no-ops.
    const targets = [repo, ...children.map((c) => join(repo, c))];
    if (opts.dryRun) {
        console.error(formatPlan(plan, ids, repo, home));
        for (const child of children)
            console.error(`\n— ${child}/ (workspace child)\n` + formatPlan(planInit(join(repo, child), { home }), ids, join(repo, child), home));
        return;
    }
    if (ids.length === 0) {
        console.error("· no agents selected — nothing written");
        return;
    }
    const wantClaude = ids.includes("claude");
    const cliPath = fileURLToPath(import.meta.url);
    if (children.length)
        console.error(`· workspace: wiring ${repo} and ${children.length} child repo(s) — ${children.join(", ")}`);
    for (const target of targets) {
        if (target !== repo)
            console.error(`\n— ${relative(repo, target)}/`);
        wireTarget(target, ids, { home, cliPath, plan, opts, wantClaude });
    }
    if (opts.brain === "local") {
        const result = configureLocalBrain(repo, { background: true, contextDir: program.opts().dir });
        if (result.ruleCount) rewriteBrainSections(repo, home, ids);
        scheduleLocalBrain(repo);
        console.error(`✓ local brain enabled (${result.ruleCount} rules preserved); grafly brain status shows worker progress`);
    }
    // One epilogue for the whole run. A workspace parent holds no nodes of its
    // own, so the totals come from the children — the graph the user actually got.
    const globalDir = program.opts().dir;
    const graphs = (children.length ? children.map((c) => join(repo, c)) : [repo])
        .map((d) => loadGraphCached(contextDirFor(d, children.length ? undefined : globalDir)))
        .filter((g) => g !== null);
    console.error("\n" +
        formatInitEpilogue({
            graphBuilt: graphs.length > 0,
            nodes: graphs.reduce((n, g) => n + g.meta.nodeCount, 0),
            edges: graphs.reduce((n, g) => n + g.meta.edgeCount, 0),
        }));
    // Sorted so `claude,cursor` and `cursor,claude` aggregate as one value.
    track("init_completed", { agents: [...ids].sort().join(","), consent: consent === undefined ? "unasked" : String(consent) }, { repo });
});
/** One repo's worth of `init` writes — the parent, then each workspace child. */
function wireTarget(repo, ids, ctx) {
    const { home, cliPath, plan, wantClaude, opts } = ctx;
    const wantStatusline = statuslineWanted({ statusline: opts.statusline });
    // Converge, don't just add. init writes the selected hosts; without this it
    // never touches the rest, so a repo wired by an older version (or by the same
    // version with different --agents) keeps that run's files forever — and
    // `reconcileWiring` then keeps them *up to date*, which is worse than stale.
    // Retract every host NOT being written now; `exclude` spares the ones about to
    // be rewritten, and the graph cache is kept (init is one step from using it).
    if (wantClaude) {
        // `global`/`home` are threaded through alongside `statusline`: the claude layer
        // writes under `~/.claude` now (hosts/claude-global.ts), so --no-global has to
        // reach it or the flag would silently mean "no out-of-repo writes, except three".
        const res = runInit(repo, { build: opts.build, cliPath, statusline: wantStatusline, global: opts.global, home });
        console.error(`✓ wrote ${res.settingsPath}`);
        for (const s of res.shims)
            console.error(`✓ wrote ${s}`);
        console.error(`✓ wrote ${res.skill}`);
        console.error(res.built ? "✓ built the graph (grafly build)" : "· skipped Grafly graph build");
        if (!wantStatusline)
            console.error("· skipped Claude Code statusLine (--no-statusline)");
        for (const w of res.warnings)
            console.error(`⚠ ${w}`);
    }
    const retracted = changed(runRetract(repo, { home, apply: true, global: opts.global, cache: false, exclude: ids })).filter((r) => r.action !== "skipped-unparseable");
    for (const r of retracted)
        console.error(`- removed ${r.path} (${r.what}) — agent not selected`);
    // `ids` is already resolved, so hosts init is always driven by an explicit
    // list — never by its own detection fallback.
    const others = ids.filter((id) => id !== "claude");
    if (others.length > 0) {
        const r = runHostsInit(repo, {
            agents: others,
            home,
            hooks: opts.hooks,
            global: opts.global,
        });
        for (const w of r.written)
            console.error(`✓ ${w.id}: ${w.path} (${w.action})`);
        for (const h of r.hooks)
            console.error(`✓ hook ${h.id}: ${h.path} (${h.action})`);
        // Only worth saying when there was actually something out-of-repo to skip.
        if (opts.global === false && selectedWrites(plan, ids).some((w) => w.scope === "global"))
            console.error("· skipped out-of-repo writes (--no-global)");
    }
    // Record WHICH graft wrote this repo's agent files, and under which flags.
    // Every entry point compares this against the running binary and re-writes
    // them on a mismatch, so an `npm i -g` upgrade reaches the hooks/skill/rules
    // too — not just the binary. The flags ride along so a refresh replays the
    // user's choices (notably --no-global) instead of overriding them.
    writeStamp(repo, currentVersion, ids, {
        global: opts.global !== false,
        hooks: opts.hooks !== false,
        statusline: wantStatusline,
    });
    // Every host's wiring points at .grafly/, so the graph is built whatever was
    // selected — not only when Claude Code is in the list (runInit does its own).
    if (!wantClaude) {
        console.error(buildGraphIfMissing(repo, { build: opts.build, cliPath })
            ? "✓ built the graph (grafly build)"
            : "· skipped Grafly graph build");
    }
}
/** Group a retraction report by host, so the output reads as "what leaves each agent". */
function formatRetractions(rs, apply) {
    const hit = changed(rs);
    if (hit.length === 0)
        return "· nothing to remove — no Grafly wiring found here";
    const verb = apply ? "removed" : "would remove";
    const lines = [];
    const byHost = new Map();
    for (const r of hit) {
        const k = byHost.get(r.hostId) ?? [];
        k.push(r);
        byHost.set(r.hostId, k);
    }
    for (const [host, items] of byHost) {
        lines.push(`\n${host}:`);
        for (const r of items) {
            const mark = r.action === "skipped-unparseable"
                ? "⚠"
                : r.action === "deleted"
                    ? "-"
                    : "~";
            const note = r.action === "skipped-unparseable"
                ? " — not valid JSON, left untouched (remove the legacy Grafly/Graft entry by hand)"
                : r.action === "deleted"
                    ? ` (${r.what} — deleted)`
                    : ` (${r.what})`;
            const scope = r.scope === "global" ? " [machine-wide]" : "";
            lines.push(`  ${mark} ${verb}: ${r.path}${scope}${note}`);
        }
    }
    return lines.join("\n").replace(/^\n/, "");
}
program
    .command("uninstall")
    .description("Remove every file and config entry Grafly has written to this repo (the inverse of init)")
    .argument("[dir]", "target repo directory", ".")
    .option("-y, --yes", "actually remove (without this, prints what it would remove and exits)")
    .option("--keep-cache", "keep .grafly/ and the .gitignore entries — wiring only")
    .option("--no-global", "leave out-of-repo files alone (~/.codex, ~/.gemini)")
    .action((dir, opts) => {
    const repo = resolve(dir);
    const home = homedir();
    const common = { home, global: opts.global, cache: opts.keepCache ? false : true };
    if (!opts.yes) {
        console.error(formatRetractions(planRetract(repo, common), false));
        console.error("\nDry run — nothing was touched. Re-run with -y to remove.");
        if (opts.global !== false)
            console.error("Entries marked [machine-wide] affect every project; --no-global skips them.");
        return;
    }
    const done = runRetract(repo, { ...common, apply: true });
    console.error(formatRetractions(done, true));
    const bad = changed(done).filter((r) => r.action === "skipped-unparseable");
    console.error(bad.length
        ? `\n⚠ ${bad.length} file(s) could not be parsed and were left as-is — see above.`
        : "\n✓ Grafly fully removed. `grafly init` re-wires from scratch.");
});
program
    .command("migrate")
    .description("Replace legacy Graft wiring/cache with Grafly, re-register detected agents, and rebuild the graph")
    .argument("[dir]", "target repo directory", ".")
    .option("--dry-run", "show what would be removed and rebuilt without changing files")
    .option("--no-build", "rewire Grafly but skip rebuilding the graph")
    .option("--no-global", "leave machine-wide agent configuration untouched")
    .action((dir, opts) => {
    const repo = resolve(dir);
    const home = homedir();
    const common = { home, global: opts.global, cache: true };
    const planned = planRetract(repo, common);
    const blocked = changed(planned).filter((r) => r.action === "skipped-unparseable");
    if (opts.dryRun) {
        console.error(formatRetractions(planned, false));
        console.error("\nWould then run Grafly init for detected agents and " +
            (opts.build === false ? "skip graph build." : "rebuild .grafly/."));
        return;
    }
    if (blocked.length > 0) {
        console.error(formatRetractions(planned, false));
        console.error(`\n✗ migration stopped before making changes: ${blocked.length} config file(s) could not be parsed.`);
        process.exitCode = 1;
        return;
    }
    const removed = runRetract(repo, { ...common, apply: true });
    console.error(formatRetractions(removed, true));
    const cliPath = fileURLToPath(import.meta.url);
    const initArgs = [cliPath, "init", repo, "-y", "--no-build"];
    if (opts.global === false)
        initArgs.push("--no-global");
    const initRun = spawnSync(process.execPath, initArgs, { cwd: repo, stdio: "inherit", env: process.env });
    if (initRun.error || (initRun.status ?? 1) !== 0) {
        console.error(`\n✗ Grafly init failed${initRun.error ? `: ${initRun.error.message}` : ""}`);
        process.exitCode = 1;
        return;
    }
    if (opts.build !== false) {
        const buildRun = spawnSync(process.execPath, [cliPath, "build", repo], { cwd: repo, stdio: "inherit", env: process.env });
        if (buildRun.error || (buildRun.status ?? 1) !== 0) {
            console.error(`\n✗ Grafly build failed${buildRun.error ? `: ${buildRun.error.message}` : ""}`);
            process.exitCode = 1;
            return;
        }
    }
    console.error("\n✓ migration complete — legacy Graft wiring was replaced by Grafly.");
});
const brain = program
    .command("brain")
    .description("Local repository rules and opt-in background mining; no Brain server required");
brain
    .command("enable")
    .description("Enable local background mining, preserving cached rules from any old connection")
    .argument("[dir]", "target repo directory", ".")
    .action((dir) => {
        const repo = resolve(dir);
        const result = configureLocalBrain(repo, { background: true, contextDir: program.opts().dir });
        if (result.ruleCount) rewriteBrainSections(repo, homedir());
        const started = scheduleLocalBrain(repo);
        console.error(`✓ local brain enabled (${result.ruleCount} rules preserved${result.migrated ? ", migrated from remote" : ""})`);
        console.error(started ? "· background mining scheduled; grafly brain status shows progress" : "· background mining is already enabled; grafly brain mine runs a pass now");
    });
brain
    .command("disable")
    .alias("disconnect")
    .description("Stop automatic mining; preserve local notes and cached rules")
    .argument("[dir]", "target repo directory", ".")
    .action((dir) => {
        const result = configureLocalBrain(resolve(dir), { background: false });
        console.error(`✓ background mining disabled (${result.ruleCount} rules preserved)`);
    });
brain
    .command("mine")
    .description("Mine local history and docs with your configured model; append rules without a Brain server")
    .argument("[dir]", "target repo directory", ".")
    .action(async (dir) => {
        const result = await mineLocalBrain(resolve(dir), { contextDir: program.opts().dir });
        console.error(`brain: ${result.status}${result.total !== undefined ? ` (${result.added} added, ${result.total} rules)` : ""}`);
        if (result.error) console.error(result.error);
        process.exitCode = result.exitCode ?? (result.status === "busy" ? 1 : 0);
    });
brain
    .command("note")
    .description("Record a rule the author already knows — no brain server, no LLM key")
    .argument("[dir]", "target repo directory", ".")
    .option("--symbol <id>", "graph symbol id the rule governs (e.g. src/a.js#foo)")
    .option("--rule <text>", "the rule, one sentence")
    .option("--source <ref>", "attribution: a commit sha, PR number, or URL")
    .option("--repo-wide", "rule applies to the whole repo, not one symbol")
    .option("--file <path>", "JSON file of rules to add: an array, or {anchors:[...]}")
    .action(async (dir, opts) => {
    const repo = resolve(dir);
    let entries = [];
    if (opts.file) {
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(resolve(opts.file), "utf8"));
        }
        catch (e) {
            console.error(`✗ --file: ${e instanceof Error ? e.message : e}`);
            process.exitCode = 1;
            return;
        }
        entries = Array.isArray(parsed) ? parsed : parsed?.anchors ?? [];
        if (!Array.isArray(entries) || entries.length === 0) {
            console.error("✗ --file: expected an array of rules or {anchors:[...]}");
            process.exitCode = 1;
            return;
        }
    }
    else if (opts.rule) {
        entries = [{ rule: opts.rule, symbol: opts.symbol, sourceUrl: opts.source, repoWide: opts.repoWide === true }];
    }
    else {
        console.error("✗ nothing to add — pass --rule (with --symbol or --repo-wide), or --file");
        process.exitCode = 1;
        return;
    }
    configureLocalBrain(repo);
    const graph = loadGraphCached(contextDirFor(repo, program.opts().dir));
    const res = addRules(repo, entries, graph);
    for (const r of res.rejected)
        console.error(`✗ ${r.error}${r.symbol ? ` (${r.symbol})` : ""}: ${r.rule}`);
    if (res.added.length) {
        const writes = rewriteBrainSections(repo, homedir());
        console.error(`✓ ${res.added.length} rule(s) noted (${res.total} cached)`);
        for (const w of writes)
            console.error(`✓ ${w.path} (${w.action})`);
    }
    if (res.rejected.length && !res.added.length)
        process.exitCode = 1;
});
brain
    .command("digest")
    .description("Print the repo digest a brain would mine — feed it to any LLM, then `grafly brain note --file` the result")
    .argument("[dir]", "target repo directory", ".")
    .option("--out <path>", "write the digest JSON to a file instead of stdout")
    .action(async (dir, opts) => {
    const repo = resolve(dir);
    const graph = loadGraphCached(contextDirFor(repo, program.opts().dir));
    if (!graph)
        console.error("· no graph yet — run `grafly build` first so symbols can anchor");
    const built = await buildLocalDigest(repo, graph, { autoApprove: true });
    if ("error" in built) {
        console.error(`✗ ${built.error}`);
        process.exitCode = 1;
        return;
    }
    if (built.warning)
        console.error(`⚠ ${built.warning}`);
    const json = JSON.stringify(built.digest);
    if (opts.out) {
        writeFileSync(resolve(opts.out), json);
        console.error(`✓ digest written to ${opts.out} (${json.length} bytes)`);
    }
    else {
        process.stdout.write(json + "\n");
    }
});
brain
    .command("status")
    .description("Show local worker state, cached rules and stale anchors")
    .argument("[dir]", "target repo directory", ".")
    .option("--json", "machine-readable output")
    .action((dir, opts) => {
    const repo = resolve(dir);
    const { link, rules, fetchedAt } = brainStatus(repo);
    // Resolve every cached rule against the CURRENT graph, so the count of stale
    // rules is the real one rather than what was true at pull time. This is the
    // number worth surfacing: it says how far the codebase has drifted from what
    // the team decided.
    const graph = loadGraphCached(contextDirFor(repo, program.opts().dir));
    const applied = anchoredRules(rules, graph);
    if (opts.json) {
        console.log(JSON.stringify({ brainId: link?.brainId ?? null, mode: link?.local ? "local" : link ? "legacy-remote" : null, background: link?.background === true, worker: localBrainState(repo), cached: rules.length, fetchedAt, anchored: applied.length, stale: applied.filter((a) => a.stale).length }, null, 2));
        return;
    }
    if (!link) {
        console.error("· no local brain yet — run grafly brain enable, or add a rule with grafly brain note");
        return;
    }
    console.error(link.local ? `local brain (background ${link.background ? "enabled" : "disabled"})` : "legacy remote cache — run grafly brain enable to migrate locally");
    const worker = localBrainState(repo);
    if (worker) console.error(`  worker: ${worker.status}${worker.error ? ` — ${worker.error}` : ""}`);
    console.error(`  ${rules.length} rule(s) cached${fetchedAt ? `, updated ${new Date(fetchedAt).toISOString()}` : ""}`);
    if (!graph) {
        console.error("  no graph yet — run `grafly build` to see which rules still match the code");
        return;
    }
    const stale = applied.filter((a) => a.stale);
    console.error(`  ${applied.length} anchored to symbols in this repo`);
    console.error(stale.length
        ? `  ${stale.length} describe code that has changed since:`
        : "  none describe code that has changed since");
    for (const a of stale.slice(0, 10))
        console.error(`    - ${a.rule}\n      ${a.pointer}`);
});
return program;
}

export async function runCli(argv = process.argv.slice(2)) {
    try {
        await createCli().exitOverride().parseAsync(argv, { from: "user" });
        return process.exitCode ?? 0;
    } catch (error) {
        if (Number.isInteger(error.exitCode)) return error.exitCode;
        console.error(error instanceof Error ? error.message : error);
        return 1;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    process.exitCode = await runCli();
