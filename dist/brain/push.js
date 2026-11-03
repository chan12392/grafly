/**
 * Building a brain from the repository already on this machine.
 *
 * The default digest reads local commits, documentation, configuration and symbol
 * metadata only. GitHub discussion is an explicit legacy API opt-in. Mining sends
 * this digest to the user's selected model, which may be local or remote.
 */
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { buildDigest, readCommits, readSymbols, readThreads, } from "../app/history.js";
import { budgetSources, readAgentInstructions, readBranchProtection, readCodeowners, readCodifiedRules, readDecisionDocs, readDeclinedIssues, readReverts, readTestNames, } from "../app/sources.js";
import { baseUrlFor } from "./link.js";
function git(root, args) {
    const res = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    if (res.error || res.status !== 0 || typeof res.stdout !== "string")
        return null;
    return res.stdout.trim();
}
/**
 * owner/name for this checkout, from its origin remote.
 *
 * Only GitHub, because the discussion reader and the forge links are
 * GitHub-shaped; another forge would need its own reader, not a looser regex
 * here that produces links to nowhere.
 */
export function repoSlugFromGit(root) {
    const url = git(root, ["remote", "get-url", "origin"]);
    if (!url)
        return null;
    const m = url.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i);
    if (!m)
        return null;
    return { owner: m[1], name: m[2] };
}
/** The branch to attribute the ingest to. */
function currentBranch(root) {
    const head = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return head && head !== "HEAD" ? head : "";
}
/**
 * A GitHub token from wherever the user already keeps one.
 *
 * `gh auth token` first, because anyone who works with private repositories on
 * the command line has it and it needs no setup at all. The env vars are the
 * CI path. Absent, the ingest still runs on commits alone — pull-request
 * discussion is the richest source, not a required one.
 */
export function githubToken() {
    const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (env)
        return env;
    const res = spawnSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const out = typeof res.stdout === "string" ? res.stdout.trim() : "";
    return res.status === 0 && out ? out : null;
}
/** Whether the repository is private, so the digest records it honestly. */
async function isPrivate(owner, name, token, fetchImpl) {
    if (!token)
        return true; // unknown counts as private
    try {
        const res = await fetchImpl(`https://api.github.com/repos/${owner}/${name}`, {
            headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
        });
        if (!res.ok)
            return true;
        return (await res.json()).private !== false;
    }
    catch {
        return true;
    }
}
/**
 * The repository this brain expects, or null when it expects none.
 *
 * The website records it when the user chooses the local route, so this is how
 * the CLI knows whether the directory it is standing in is the one they asked
 * for. Mining the wrong repo into a brain is silent and very hard to notice
 * afterwards — the rules simply describe someone else's codebase — so the round
 * trip is worth it.
 *
 * Null on any failure, which keeps an older brain (or an unreachable one)
 * working exactly as it did before this check existed.
 */
export async function fetchExpectedRepo(link, fetchImpl = fetch) {
    try {
        const res = await fetchImpl(`${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/repo`, {
            headers: { authorization: `Bearer ${link.token}`, accept: "application/json" },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok)
            return null;
        const body = (await res.json());
        if (!body.repo?.slug)
            return null;
        return { slug: body.repo.slug, status: String(body.repo.status ?? ""), brainName: String(body.brain_name ?? "") };
    }
    catch {
        return null;
    }
}
/** Whether two repo slugs name the same repository. GitHub is case-insensitive. */
export function sameRepo(a, b) {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}
/** Build the digest for the checkout at `root`. Reads nothing but text. */
export async function buildLocalDigest(root, graph, opts = {}) {
    const github = repoSlugFromGit(root);
    const slug = github ?? { owner: '', name: basename(root) };
    const fetchImpl = opts.fetchImpl ?? fetch;
    const token = opts.github === true && github ? githubToken() : null;
    const commits = readCommits(root);
    if (commits.length === 0) {
        return { error: "no commits found here — is this a shallow clone with no history?" };
    }
    const symbols = readSymbols(graph);
    let threads = [];
    let warning;
    if (token) {
        try {
            threads = await readThreads(slug.owner, slug.name, token, fetchImpl);
        }
        catch {
            warning = "could not read pull-request discussion; mining commits and repo files only";
        }
    }
    else if (opts.github === true) {
        warning =
            "no GitHub token found (`gh auth login`, or GH_TOKEN) — mining commits and repo files only, without pull-request discussion";
    }
    const branch = currentBranch(root);
    const sources = budgetSources([
        ...readAgentInstructions(root),
        ...readDecisionDocs(root),
        ...readCodeowners(root),
        ...readCodifiedRules(root),
        ...readReverts(root),
        ...readTestNames(symbols.map((s) => ({ name: s.name, path: s.path }))),
        ...(token ? await readBranchProtection(slug.owner, slug.name, branch, token, fetchImpl) : []),
        ...(token ? await readDeclinedIssues(slug.owner, slug.name, token, fetchImpl) : []),
    ]);
    const digest = buildDigest({
        owner: slug.owner,
        name: slug.name,
        headSha: git(root, ["rev-parse", "HEAD"]) ?? "",
        defaultBranch: branch,
        isPrivate: await isPrivate(slug.owner, slug.name, token, fetchImpl),
        commits,
        threads,
        symbols,
        sources,
        autoApprove: opts.autoApprove ?? true,
    });
    if (!github) digest.provider = 'local';
    return { digest, warning };
}
/** Send a digest to the brain and return the job to poll. */
export async function pushDigest(link, digest, fetchImpl = fetch) {
    try {
        const url = `${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/repo`;
        const res = await fetchImpl(url, {
            method: "POST",
            headers: {
                authorization: `Bearer ${link.token}`,
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify(digest),
        });
        const text = await res.text();
        if (!res.ok)
            return { error: `the brain refused the ingest: ${res.status} ${text.slice(0, 200)}` };
        return { jobId: String(JSON.parse(text).job_id ?? "") };
    }
    catch (e) {
        return { error: `could not reach the brain: ${e instanceof Error ? e.message : e}` };
    }
}
