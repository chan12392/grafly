/**
 * Everything in a repository that is already a rule, or nearly one.
 *
 * Commit messages and pull-request discussion say what a team decided in
 * passing. These are the places where they wrote it down on purpose: the
 * instruction files they hand their own agents, the decision records, the linter
 * config, the ownership rules. Higher precision per byte than any amount of
 * history, and most of it is a file read.
 *
 * Every reader returns text, never source code, and every one is best-effort:
 * a repo with none of these still builds a brain from its history.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
/** Per-file and total caps, so one enormous doc cannot crowd out everything. */
const MAX_FILE_CHARS = 24_000;
const MAX_TOTAL_CHARS = 300_000;
const MAX_SOURCES = 120;
function readText(root, rel) {
    try {
        const p = join(root, rel);
        if (!existsSync(p) || !statSync(p).isFile())
            return null;
        const raw = readFileSync(p, "utf8");
        const trimmed = raw.trim();
        if (!trimmed)
            return null;
        return trimmed.length > MAX_FILE_CHARS ? `${trimmed.slice(0, MAX_FILE_CHARS)}\n[…truncated]` : trimmed;
    }
    catch {
        return null;
    }
}
/** Files directly under `rel`, one level deep, matching `test`. */
function filesIn(root, rel, test) {
    try {
        const dir = join(root, rel);
        if (!existsSync(dir) || !statSync(dir).isDirectory())
            return [];
        return readdirSync(dir)
            .filter(test)
            .map((n) => join(rel, n))
            .sort();
    }
    catch {
        return [];
    }
}
/**
 * Instruction files the team already wrote for coding agents.
 *
 * The single highest-precision source in a repository: someone sat down and
 * wrote imperative rules for a machine to follow. Nothing has to be inferred.
 *
 * Graft's own managed blocks are stripped first. Without that the brain reads
 * back graft's instructions about using graft, and then graft carries them into
 * the same file — a loop that fills the rulebook with itself.
 */
export function readAgentInstructions(root) {
    const candidates = [
        "CLAUDE.md",
        "AGENTS.md",
        "GEMINI.md",
        ".github/copilot-instructions.md",
        ".windsurf/rules/graft.md",
        ...filesIn(root, ".cursor/rules", (n) => n.endsWith(".mdc") || n.endsWith(".md")),
    ];
    const out = [];
    for (const rel of candidates) {
        const text = stripManagedBlocks(readText(root, rel) ?? "");
        if (text.trim())
            out.push({ kind: "agent_instructions", path: rel, text });
    }
    return out;
}
/** Remove graft's own fenced regions, so the brain never learns graft from graft. */
function stripManagedBlocks(text) {
    return text
        .replace(/<!--\s*graft:(brain:)?start\s*-->[\s\S]*?<!--\s*graft:(brain:)?end\s*-->/g, "")
        .trim();
}
/** Architecture decision records and the docs that read like them. */
export function readDecisionDocs(root) {
    const mdIn = (dir) => filesIn(root, dir, (n) => n.endsWith(".md"));
    const candidates = [
        "ARCHITECTURE.md",
        "CONTRIBUTING.md",
        "docs/ARCHITECTURE.md",
        "docs/CONTRIBUTING.md",
        ...mdIn("docs/adr"),
        ...mdIn("docs/decisions"),
        ...mdIn("adr"),
    ];
    const out = [];
    for (const rel of candidates) {
        const text = readText(root, rel);
        if (text)
            out.push({ kind: "decision_doc", path: rel, text });
    }
    return out;
}
/**
 * Rules the team already encoded for a machine: linters, formatters, and the
 * checks CI insists on. Nothing to infer — extraction only has to phrase them.
 */
export function readCodifiedRules(root) {
    const lint = [
        ".golangci.yml",
        ".golangci.yaml",
        ".eslintrc.json",
        ".eslintrc.js",
        "eslint.config.js",
        "eslint.config.mjs",
        "ruff.toml",
        ".ruff.toml",
        ".prettierrc",
        ".prettierrc.json",
        "commitlint.config.cjs",
        "commitlint.config.js",
        ".editorconfig",
    ];
    const out = [];
    for (const rel of lint) {
        const text = readText(root, rel);
        if (text)
            out.push({ kind: "lint_config", path: rel, text });
    }
    for (const rel of filesIn(root, ".github/workflows", (n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
        const text = readText(root, rel);
        if (text)
            out.push({ kind: "ci_config", path: rel, text });
    }
    return out;
}
/** Who must approve what. A hard constraint, stated as a file. */
export function readCodeowners(root) {
    for (const rel of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
        const text = readText(root, rel);
        if (text)
            return [{ kind: "codeowners", path: rel, text }];
    }
    return [];
}
/** Run git in `root`, or null when it fails. */
function git(root, args) {
    const res = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error || res.status !== 0 || typeof res.stdout !== "string")
        return null;
    return res.stdout;
}
/** How many reverts to carry. */
const MAX_REVERTS = 40;
/**
 * Commits that undid another commit.
 *
 * "We tried this and took it back" is a rule available from nowhere else, and
 * it is the one kind of history that says what NOT to do. The body of a revert
 * usually names the commit it undoes and, when the author bothered, why.
 */
export function readReverts(root, max = MAX_REVERTS) {
    const out = git(root, ["log", "--grep=^Revert", "-n", String(max), "--format=%H%x02%s%x02%b%x01"]);
    if (!out)
        return [];
    const sources = [];
    for (const record of out.split("\x01")) {
        if (!record.trim())
            continue;
        const [sha = "", subject = "", body = ""] = record.split("\x02");
        if (!sha.trim() || !subject.trim())
            continue;
        sources.push({
            kind: "revert",
            path: `revert ${sha.trim().slice(0, 12)}`,
            text: [subject.trim(), body.trim()].filter(Boolean).join("\n"),
        });
    }
    return sources;
}
/** How many test names to carry. */
const MAX_TEST_NAMES = 300;
/**
 * Test names, which are invariants someone wrote deliberately.
 *
 * `never retries on a card decline` is a rule stated as an assertion. Read from
 * the graph's own symbols rather than by re-parsing, so this costs nothing:
 * a test function is already a node.
 *
 * Only names that read like a sentence are kept. `TestFoo` is a label;
 * `rejects an expired token` is a claim about how the system must behave.
 */
export function readTestNames(symbolNames, max = MAX_TEST_NAMES) {
    const out = [];
    for (const s of symbolNames) {
        if (!/(^|[/.])(test|spec)[s]?[/.]|_test\.|\.test\.|\.spec\./i.test(s.path))
            continue;
        const sentence = humanizeTestName(s.name);
        if (!sentence)
            continue;
        out.push({ kind: "test_name", path: s.path, text: sentence });
        if (out.length === max)
            break;
    }
    return out;
}
/**
 * A test's name as a claim, or null when it is only a label.
 *
 * Requires three words after the prefix is stripped: fewer than that
 * ("TestParse", "handles errors") states no invariant worth a rule, and letting
 * those through fills the brain with noise that reads like content.
 */
function humanizeTestName(name) {
    let s = name.replace(/^(Test|it|test|should|describe)[_\s]*/i, "");
    // TestRetriesThreeTimes → Retries Three Times
    if (/^[A-Za-z]+$/.test(s) && /[a-z][A-Z]/.test(s))
        s = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    s = s.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    if (s.split(" ").length < 3)
        return null;
    return s.toLowerCase();
}
/** How many declined issues to carry. */
const MAX_DECLINED = 40;
/**
 * Issues closed as not planned.
 *
 * A decision NOT to build something, which is half of what a codebase's rules
 * are and is invisible everywhere else — nothing was committed, so no commit
 * message records it.
 */
export async function readDeclinedIssues(owner, repo, token, fetchImpl, api = "https://api.github.com", max = MAX_DECLINED) {
    try {
        const res = await fetchImpl(`${api}/repos/${owner}/${repo}/issues?state=closed&per_page=100&sort=updated`, {
            headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "graft-app" },
        });
        if (!res.ok)
            return [];
        const items = JSON.parse(await res.text());
        if (!Array.isArray(items))
            return [];
        const out = [];
        for (const i of items) {
            // The issues endpoint returns pull requests too; they are already mined as
            // threads and would be counted twice.
            if (i.pull_request)
                continue;
            if (i.state_reason !== "not_planned")
                continue;
            if (!i.title?.trim())
                continue;
            out.push({
                kind: "declined_issue",
                path: `issue #${i.number}`,
                text: [i.title.trim(), (i.body ?? "").trim()].filter(Boolean).join("\n").slice(0, MAX_FILE_CHARS),
                url: i.html_url,
            });
            if (out.length === max)
                break;
        }
        return out;
    }
    catch {
        return [];
    }
}
/** Required checks and reviewers on the default branch. */
export async function readBranchProtection(owner, repo, branch, token, fetchImpl, api = "https://api.github.com") {
    if (!branch)
        return [];
    try {
        const res = await fetchImpl(`${api}/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`, {
            headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "graft-app" },
        });
        // 404 simply means the branch is not protected, which is not a failure.
        if (!res.ok)
            return [];
        const p = JSON.parse(await res.text());
        const lines = [];
        const checks = p.required_status_checks?.contexts ?? [];
        if (checks.length)
            lines.push(`Checks that must pass before merging to ${branch}: ${checks.join(", ")}.`);
        const reviews = p.required_pull_request_reviews;
        if (reviews?.required_approving_review_count) {
            lines.push(`${reviews.required_approving_review_count} approving review(s) required to merge to ${branch}.`);
        }
        if (reviews?.require_code_owner_reviews)
            lines.push(`A code owner must approve changes to ${branch}.`);
        if (p.allow_force_pushes?.enabled === false)
            lines.push(`Force pushes to ${branch} are not allowed.`);
        if (!lines.length)
            return [];
        return [{ kind: "branch_protection", path: `branch protection: ${branch}`, text: lines.join("\n") }];
    }
    catch {
        return [];
    }
}
/**
 * Trim the collected sources to a budget, best kinds first.
 *
 * The order is the argument of this whole module: a file the team wrote to
 * instruct an agent outranks a decision doc, which outranks a config, which
 * outranks anything inferred. When the budget runs out it should run out on the
 * weakest evidence.
 */
const KIND_RANK = [
    "agent_instructions",
    "decision_doc",
    "codeowners",
    "branch_protection",
    "lint_config",
    "ci_config",
    "revert",
    "declined_issue",
    "test_name",
];
export function budgetSources(sources, maxChars = MAX_TOTAL_CHARS, maxCount = MAX_SOURCES) {
    const ranked = [...sources].sort((a, b) => KIND_RANK.indexOf(a.kind) - KIND_RANK.indexOf(b.kind));
    const out = [];
    let spent = 0;
    for (const s of ranked) {
        if (out.length >= maxCount)
            break;
        if (spent + s.text.length > maxChars)
            continue;
        out.push(s);
        spent += s.text.length;
    }
    return out;
}
/** Repo-relative path, for readers handed an absolute one. */
export function relPath(root, abs) {
    return relative(root, abs) || abs;
}
//# sourceMappingURL=sources.js.map