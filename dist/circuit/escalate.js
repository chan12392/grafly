/**
 * MC escalation — when the circuit surfaces ambiguity it cannot resolve
 * (same-name matches whose call sites were dropped at resolve time), hand the
 * dropped sites to morecoffee's live `code_relation` channel: the evidence
 * engine this circuit's recipe was ported from. The circuit ranks with what
 * the graph knows; MC re-parses the actual source and answers which candidate
 * each dropped call site binds to — import-scope evidence the graph's
 * name-level resolver had to drop.
 *
 * Opt-in through ~/.grafly/mc-analyzer.json or environment; never fatal:
 *   GRAFLY_MC_HOME       trusted morecoffee checkout (overrides saved config;
 *                        an explicitly empty value disables the saved home)
 *   GRAFLY_MC=0 / GRAFLY_NO_MC=1   kill switch even when HOME is set
 *   GRAFLY_MC_PYTHON     interpreter (saved absolute path, then "python");
 *                        isolated startup imports only the trusted MC home
 *   GRAFLY_MC_TIMEOUT_MS per-request spawn timeout (default 15000)
 *   GRAFLY_MC_MAX_SITES  dropped call-site files escalated per query (default 5)
 *   GRAFLY_MC_DEADLINE_MS total escalation budget across all sites (default 45000)
 *   GRAFLY_MC_CACHE      override for the analysis snapshot dir. Default is
 *                        ~/.cache/grafly/mc-<hash(root)> — outside the scanned
 *                        repo, which code_relation requires
 *                        (cache_inside_source is a hard error there).
 *
 * One MC `judge` request per distinct call-site file: query={file} is MC's
 * file-level lexical mode — it gathers that file's reference rows and checks
 * which candidate's resolved symbols appear as possible targets. relation is
 * "references" because dropped edges mix calls and bare references and
 * MC's references evidence set already includes call rows.
 *
 * Serial spawns are deliberate: each call is bounded, the first pays the cold
 * scan (~2.5s on a mid repo) and the snapshot cache makes the rest ~0.3s.
 * The resident `morecoffee.channels.channel_host` is the upgrade path if this
 * ever shows up in a profile — the wire format is identical.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_DEADLINE_MS = 45000;
const DEFAULT_MAX_SITES = 5;
const MC_MAX_CANDIDATES = 64; // code_relation's default limits.max_candidates
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024; // code_relation_stdio's own stdin cap

/** Cache source identity alone is insufficient after an analyzer upgrade. */
export function analyzerIdentity(home) {
    const hash = createHash('sha256');
    let files = 0, bytes = 0;
    function visit(dir, prefix = '') {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isSymbolicLink() || entry.name === '__pycache__') continue;
            const path = join(dir, entry.name), name = prefix + entry.name;
            if (entry.isDirectory()) visit(path, name + '/');
            else if (entry.isFile() && /\.(py|json)$/.test(entry.name)) {
                if (++files > 5000 || (bytes += statSync(path).size) > 64 * 1024 * 1024) throw new Error('MC installation too large');
                hash.update(name).update('\0').update(readFileSync(path));
            }
        }
    }
    try { visit(join(home, 'morecoffee')); return hash.digest('hex').slice(0, 16); }
    catch { return 'unavailable'; }
}

function envOff() {
    const v = process.env.GRAFLY_MC ?? "1";
    if (v === "0" || v === "false")
        return true;
    return !!process.env.GRAFLY_NO_MC;
}

export function mcConfig(root) {
    if (envOff())
        return null;
    let saved = {};
    try {
        const path = process.env.GRAFLY_MC_CONFIG || join(homedir(), '.grafly', 'mc-analyzer.json');
        if (statSync(path).size <= 16384) saved = JSON.parse(readFileSync(path, 'utf8'));
        if (saved.schema !== 'grafly.mc-analyzer.v1' || saved.enabled !== true
            || !isAbsolute(saved.home || '') || !isAbsolute(saved.python || '')
            || !existsSync(saved.python)
            || !existsSync(join(saved.home, 'morecoffee', 'channels', 'code_relation_stdio.py'))) saved = {};
    } catch { /* explicit env configuration still works; invalid files execute nothing */ }
    // An explicitly empty environment value disables the saved home too.
    const home = process.env.GRAFLY_MC_HOME ?? saved.home;
    if (!home)
        return null;
    const num = (name, dflt) => {
        const n = Number(process.env[name]);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
    };
    const engine = analyzerIdentity(home);
    return {
        home,
        python: process.env.GRAFLY_MC_PYTHON || saved.python || "python",
        source: process.env.GRAFLY_MC_HOME !== undefined ? 'environment' : 'user-config',
        analyzerFingerprint: engine,
        timeoutMs: num("GRAFLY_MC_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
        deadlineMs: num("GRAFLY_MC_DEADLINE_MS", DEFAULT_DEADLINE_MS),
        maxSites: num("GRAFLY_MC_MAX_SITES", DEFAULT_MAX_SITES),
        cacheDir: process.env.GRAFLY_MC_CACHE
            ?? join(homedir(), ".cache", "grafly",
                "mc-" + createHash("sha256").update(root).update('\0').update(home).update('\0').update(engine).digest("hex").slice(0, 12)),
    };
}

/** Node ids are `<path>#<qualname>` (file nodes are the bare path) — the call
 * site's file is everything before the first `#`. */
function siteFile(source) {
    return String(source).split("#")[0];
}

export function judgeOneSite(cfg, root, file, candidates) {
    const body = {
        source_root: root,
        relation: "references",
        query: { file },
        candidates,
        context: { cache_dir: cfg.cacheDir },
    };
    const input = JSON.stringify(body);
    if (input.length > MAX_PAYLOAD_BYTES)
        return { site: file, status: "error", reason: "payload_over_8MiB" };
    // Do not import PYTHONPATH, user-site customizations, or the scanned repo.
    const code = "import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_module('morecoffee.channels.code_relation_stdio',run_name='__main__')";
    const r = spawnSync(cfg.python, ["-I", "-B", "-X", "utf8", "-c", code, cfg.home], {
        cwd: dirname(fileURLToPath(import.meta.url)), input, timeout: cfg.timeoutMs,
        encoding: "utf8", maxBuffer: MAX_PAYLOAD_BYTES * 2, windowsHide: true,
    });
    if (r.error)
        return { site: file, status: "error",
            reason: r.error.code === "ETIMEDOUT" ? `timeout>${cfg.timeoutMs}ms` : String(r.error.message || r.error) };
    if (r.status !== 0)
        return { site: file, status: "error",
            reason: (r.stderr || `exit ${r.status}`).trim().split("\n").pop().slice(0, 200) };
    try {
        const out = JSON.parse(r.stdout);
        if (out.channel_id !== 'code_relation' || !['ok', 'abstained', 'unsupported', 'error'].includes(out.status))
            throw new Error('invalid MC envelope');
        if (out.decision?.selected && !candidates.some(c => c.id === out.decision.selected))
            throw new Error('unknown selected candidate');
        return { site: file, status: "ok", out };
    }
    catch {
        return { site: file, status: "error", reason: "unparseable envelope" };
    }
}

/**
 * Escalate the dropped call sites for `query` to morecoffee. `matches` are the
 * same-name graph nodes (become MC candidates); `dropped` are
 * graph.ambiguousCalls entries ({source, name}) — the call sites the resolver
 * refused to guess at. Returns null when escalation is off or there is nothing
 * to hand over — callers must treat null as "no escalation ran".
 */
export function escalateAmbiguous(root, query, matches, dropped) {
    const cfg = mcConfig(root);
    if (!cfg || !matches?.length || !dropped?.length)
        return null;
    const files = [...new Set(dropped.filter((d) => d.name === query).map((d) => siteFile(d.source)))]
        .filter(Boolean)
        .slice(0, cfg.maxSites);
    if (!files.length)
        return null;
    // matches arrive circuit-ranked best-first; beyond MC's candidate cap the
    // tail is the least plausible anyway. The cap is reported, not silent.
    const truncated = matches.length > MC_MAX_CANDIDATES;
    const candidates = matches.slice(0, MC_MAX_CANDIDATES)
        .map((n) => ({ id: n.id, name: n.name, file: n.path }));
    const resolved = [], unresolved = [], errors = [];
    const t0 = Date.now();
    for (const file of files) {
        if (Date.now() - t0 > cfg.deadlineMs) {
            errors.push({ site: file, reason: `deadline>${cfg.deadlineMs}ms` });
            continue;
        }
        const r = judgeOneSite(cfg, root, file, candidates);
        if (r.status !== "ok") {
            errors.push({ site: file, reason: r.reason });
            continue;
        }
        const env = r.out;
        if (env.status === "ok" && env.decision?.selected) {
            resolved.push({ site: file, candidate: env.decision.selected,
                evidence: (env.evidence ?? []).slice(0, 3) });
        }
        else {
            unresolved.push({ site: file, status: env.status,
                reasons: env.reason_codes ?? [] });
        }
    }
    return {
        tool: "mc.code_relation", analyzer_source: cfg.source, analyzer_fingerprint: cfg.analyzerFingerprint, elapsed_ms: Date.now() - t0,
        sites: files.length, resolved, unresolved, errors,
        ...(truncated ? { candidates_capped: MC_MAX_CANDIDATES,
            candidates_total: matches.length } : {}),
    };
}

/** Human-facing lines for the escalation result, or null when nothing ran. */
export function escalationLines(esc) {
    if (!esc)
        return null;
    const lines = [`⚖ mc escalation: ${esc.resolved.length}/${esc.sites} dropped call site(s) resolved` +
        ` by code_relation (${esc.elapsed_ms}ms)` +
        (esc.candidates_capped ? ` — candidates capped at ${esc.candidates_capped}/${esc.candidates_total}` : "")];
    for (const r of esc.resolved)
        lines.push(`  ${r.site} → ${r.candidate}`);
    for (const u of esc.unresolved)
        lines.push(`  ${u.site} → still unknown (${(u.reasons || []).join(", ") || u.status})`);
    for (const e of esc.errors)
        lines.push(`  ${e.site} → mc unavailable (${e.reason})`);
    return lines;
}
