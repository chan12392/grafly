/** Neutral navigation observations and evidence-backed explicit reviews. */
import { appendFileSync, closeSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
<<<<<<< HEAD
<<<<<<< HEAD
import { collectJudgment } from '../mc-runtime/feedback.js';
=======
>>>>>>> chan12392/cstack-review-20261020
=======
>>>>>>> chan12392/feat-general-tool-output

/** Associate navigation only with judgments this recent — same sitting,
 * not last week's unrelated query. */
const NARROW_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Tail slice read per lookup and record cap — feedback lookup stays O(KB)
 * even on a log that was never rotated. */
const TAIL_BYTES = 96 * 1024;
const MAX_RECORDS = 500;
/** The log lives inside user repos; cap it so long sessions don't grow it
 * without bound. Export reviewed records before rotation when a durable
 * dataset is needed; the log itself is not a training database. */
const MAX_LOG_BYTES = 1536 * 1024;
const rootKey = root => process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);

/** Stable id for a judgment record: content-derived, so the same judgment
 * re-serialized (or an old record lacking a jid) gets the same id. */
export function jidFor(r) {
    // `top1` is the winning id in schema v2 records; older records carry it
    // only implicitly as scores[0]. (`r.top` is the --top flag — a number.)
    const top = r.top1 ?? r.scores?.[0]?.id ?? "";
    return createHash("sha1").update(`${r.ts}|${r.query}|${top}`).digest("hex").slice(0, 12);
}

/** Read the last TAIL_BYTES of a JSONL log into parsed records. When the
 * slice starts mid-file the first (partial) line is dropped; a small log
 * read whole keeps every line. Unparseable lines are skipped. */
export function readLogTail(path, maxRecords = MAX_RECORDS, maxBytes = TAIL_BYTES) {
    let buf, sliced = false;
    try {
        const size = statSync(path).size;
        const fd = openSync(path, "r");
        try {
            const start = Math.max(0, size - maxBytes);
            sliced = start > 0;
            buf = Buffer.alloc(Math.min(size, maxBytes));
            readSync(fd, buf, 0, buf.length, start);
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return [];
    }
    const lines = buf.toString("utf8").split("\n");
    // Drop the first line ONLY when the buffer starts mid-file — a small log
    // read whole has a complete first line and dropping it loses the record.
    if (sliced && lines.length > 1)
        lines.shift();
    const out = [];
    for (const line of lines) {
        if (!line)
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch { /* partial/corrupt line — skip */ }
    }
    return out.slice(-maxRecords);
}

/** Append one record, rotating the log once it passes MAX_LOG_BYTES.
 * Returns the resolved path written, or null when logging is off. */
export function appendCircuitRecord(path, record) {
    try {
        if (statSync(path).size > MAX_LOG_BYTES)
            renameSync(path, path + ".1"); // single backup generation
    }
    catch { /* absent file — append creates it */ }
    try {
        appendFileSync(path, JSON.stringify(record) + "\n");
        return path;
    }
    catch {
        return null; /* logging never blocks the answer */
    }
}

/** Record a strict-subset follow-up as neutral navigation only. */
export function recordFollowup(logPath, root, query, matchedIds) {
    if (!logPath || matchedIds.length === 0)
        return null;
    const records = readLogTail(logPath);
    if (records.length === 0)
        return null;
    const cutoff = Date.now() - NARROW_WINDOW_MS;
    for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i];
        const isJudge = r.type === "judge" || (!r.type && Array.isArray(r.scores));
        if (!isJudge || r.root !== root)
            continue;
        const ts = Date.parse(r.ts);
        if (!Number.isFinite(ts) || ts < cutoff)
            continue;
        const candIds = (r.scores ?? []).map((x) => x.id);
        if (candIds.length <= matchedIds.length || !matchedIds.every((id) => candIds.includes(id)))
            continue;
        const top1 = r.top1 ?? candIds[0] ?? null;
        const event = {
            ts: new Date().toISOString(),
            type: "narrow",
            jid: r.jid ?? jidFor(r),
            root,
            query,
            matched: matchedIds,
            selected: matchedIds.length === 1 ? matchedIds[0] : null,
            includes_top1: top1 ? matchedIds.includes(top1) : null,
        };
        return appendCircuitRecord(logPath, event) ? event : null;
    }
    return null;
}

/** Explicit reviews identify a correct candidate, or a genuinely ambiguous query. */
export function isExplicitLabel(label, judgment) {
    return Boolean(judgment && label?.schema === "grafly.circuit.label.v1" && label.type === "label"
        && label.source === "explicit" && label.jid === (judgment.jid ?? jidFor(judgment))
        && typeof label.root === "string" && typeof judgment.root === "string"
        && rootKey(label.root) === rootKey(judgment.root)
        && typeof label.ts === "string" && Number.isFinite(Date.parse(label.ts))
        && typeof label.evidence === "string" && label.evidence.trim().length > 0 && label.evidence.length <= 4096
        && typeof label.expected === "string"
        && Array.isArray(judgment.scores) && judgment.scores.length > 0
        && judgment.scores.every(s => typeof s?.id === "string" && s.id.length > 0)
        && (label.expected === "abstain" || judgment.scores.some(s => s.id === label.expected)));
}

export function recordLabel(logPath, root, jid, expected, evidence) {
    if (!logPath) throw new Error("circuit logging is disabled");
    if (typeof evidence !== "string" || !evidence.trim() || evidence.length > 4096)
        throw new Error("--evidence must contain 1..4096 characters describing the verification");
    // shortcut: review lookup reads 3 MiB per log; use streaming lookup if judgments exceed it.
    const records = [logPath + ".1", logPath].flatMap(p => readLogTail(p, Infinity, MAX_LOG_BYTES * 2));
    const judgment = records.find(r => r && (r.type === "judge" || (!r.type && Array.isArray(r.scores)))
        && (r.jid ?? jidFor(r)) === jid && typeof r.root === "string" && rootKey(r.root) === rootKey(root));
    if (!judgment) throw new Error("unknown judgment ID in this repository's retained logs");
    const label = { schema: "grafly.circuit.label.v1", ts: new Date().toISOString(), type: "label",
        source: "explicit", jid, root: judgment.root, expected, evidence: evidence.trim() };
    if (!isExplicitLabel(label, judgment)) throw new Error("expected must be an exact candidate ID, or abstain");
    if (!appendCircuitRecord(logPath, label)) throw new Error("could not persist the explicit review");
<<<<<<< HEAD
<<<<<<< HEAD
    collectJudgment(judgment, label);
=======
>>>>>>> chan12392/cstack-review-20261020
=======
>>>>>>> chan12392/feat-general-tool-output
    return label;
}
