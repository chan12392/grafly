/**
 * JS port of morecoffee's `session_compact` channel (mc.channel.v1,
 * channel_version 0.3.0, ruleset session_compact.retention.v1).
 *
 * Model-independent, REVERSIBLE tool-history compaction proposals: it never
 * summarizes prose, never reads archives, never changes a live session. Old
 * successful tool outputs may be replaced by exact-duplicate pointers or
 * archive references; explicitly archived completed call/result batches may
 * become receipts. Everything retained is verbatim; every omission is counted
 * in evidence. The caller owns archive persistence and provider mapping.
 *
 * Normalized message contract (subset of the Python channel):
 *   {id, role: system|developer|user|assistant|tool, content: string,
 *    tool_calls?: [{id,name,arguments}], tool_call_id?, outcome?: ok|error|unknown,
 *    must_keep?: bool, archive?: {ref, sha256}}
 * Payload: {messages, target_bytes, keep_last?, verification_message_ids?,
 *           completed_tool_batches?: [{call_message_id, archive:{ref,sha256}}]}
 */
import { createHash } from "node:crypto";

export const RULESET = "session_compact.retention.v1";

// ── retention rules (ported 1:1 from session_compact_rules.py) ─────────────
const ASSIGNMENT = /^\s*([A-Za-z_][A-Za-z0-9_.-]{0,127})\s*[:=]\s*(true|false|ok|pass(?:ed)?|fail(?:ed)?|[0-9]{1,10})\s*$/i;
const CHECK_KEYS = new Set([
    "ok", "success", "passed", "pass", "failed", "fail", "failure",
    "error", "errors", "valid", "verified", "verification", "test", "tests",
    "check", "checked", "assert", "assertion", "detected", "match", "equal",
]);
const UNITTEST = /^Ran [0-9]+ tests? in [0-9.]+s$/i;
const TEST_COUNT = "[0-9]+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?)";
const TEST_SUMMARY = new RegExp(
    `^(?:=+\\s*)?${TEST_COUNT}(?:,\\s*${TEST_COUNT})*(?:\\s+in\\s+[0-9.]+s(?:\\s+\\([0-9:]+\\))?)?(?:\\s*=+)?$`, "i");
const DOCTOR = /^[0-9]+ ok\s*\|.*\|\s*[0-9]+ fail(?:\s+ok)?$/i;
const EXIT = /^(?:Exit code|Process exited with code|exit_code)\s*[:=]?\s*(-?[0-9]+)$/i;

/** First applicable evidence rule; unknown formats stay unknown. */
export function retentionRule(content) {
    for (const raw of content.split("\n")) {
        if (raw.length > 512)
            continue;
        const line = raw.trim();
        if (!line)
            continue;
        const a = ASSIGNMENT.exec(line);
        if (a) {
            const key = a[1].toLowerCase().split(/[_.-]/);
            if (key.some((k) => CHECK_KEYS.has(k)))
                return "verification_assignment";
        }
        if (UNITTEST.test(line))
            return "test_summary";
        if (DOCTOR.test(line))
            return "test_summary";
        if (TEST_SUMMARY.test(line))
            return "test_summary";
        const ex = EXIT.exec(line);
        if (ex && Number(ex[1]) !== 0)
            return "nested_nonzero_exit";
    }
    return null;
}

// ── helpers ────────────────────────────────────────────────────────────────
const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v), "utf8");
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const IDENT = /^[A-Za-z0-9_.:/-]{1,128}$/;
const ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);

export class RequestError extends Error {
    constructor(code, detail) { super(detail); this.code = code; }
}

function require(cond, code, detail) {
    if (!cond)
        throw new RequestError(code, detail);
}

/** Map assistant call-message id → [owner index, ...result indices]. */
function batchIndices(messages) {
    const results = new Map();
    messages.forEach((m, i) => {
        if (m.role === "tool")
            results.set(m.tool_call_id, i);
    });
    const out = new Map();
    messages.forEach((m, i) => {
        if (m.tool_calls) {
            const idx = [i];
            for (const c of m.tool_calls)
                if (results.has(c.id))
                    idx.push(results.get(c.id));
            idx.sort((a, b) => a - b);
            out.set(m.id, idx);
        }
    });
    return out;
}

/** Validate the normalized payload; throws RequestError like the channel. */
export function validatePayload(p, limits = {}) {
    require(p && typeof p === "object" && !Array.isArray(p), "invalid_payload", "Payload must be an object");
    const maxText = limits.maxTextBytes ?? Infinity;
    require(typeof p.target_bytes === "number" && Number.isInteger(p.target_bytes) && p.target_bytes >= 1,
        "invalid_budget", "target_bytes must be a positive integer");
    const keepLast = p.keep_last ?? 8;
    require(Number.isInteger(keepLast) && keepLast >= 0, "invalid_budget", "keep_last must be a nonnegative integer");
    const messages = p.messages;
    require(Array.isArray(messages) && messages.length >= 1 && messages.length <= 4096,
        "invalid_messages", "Supply 1..4096 normalized messages");
    const ids = new Set(), calls = new Map(), returned = new Set();
    for (const m of messages) {
        require(m && typeof m === "object" && typeof m.id === "string" && IDENT.test(m.id) && !ids.has(m.id),
            "invalid_message_id", "Message IDs must be unique stable identifiers");
        ids.add(m.id);
        require(ROLES.has(m.role), "invalid_role", "Unsupported message role");
        require(typeof m.content === "string", "unsupported_content", "Only text content is supported");
        require(Buffer.byteLength(m.content, "utf8") <= maxText, "text_too_large", "Message content exceeds limit");
        require(typeof (m.must_keep ?? false) === "boolean", "invalid_pin", "must_keep must be boolean");
        if (m.role !== "tool")
            require(m.tool_call_id === undefined && m.outcome === undefined && m.archive === undefined,
                "invalid_tool_fields", "Tool result fields require role=tool");
        if (m.role !== "assistant")
            require(!("tool_calls" in m), "invalid_tool_fields", "tool_calls requires role=assistant");
        if (m.tool_calls) {
            require(Array.isArray(m.tool_calls) && m.tool_calls.length > 0, "invalid_tool_calls", "tool_calls must be nonempty");
            for (const c of m.tool_calls) {
                require(typeof c.id === "string" && IDENT.test(c.id) && !calls.has(c.id)
                    && typeof c.name === "string" && c.name && typeof c.arguments === "string",
                    "invalid_tool_calls", "Calls need unique id, name, string arguments");
                calls.set(c.id, c.name);
            }
        }
        if (m.role === "tool") {
            require(typeof m.tool_call_id === "string" && calls.has(m.tool_call_id) && !returned.has(m.tool_call_id),
                "unpaired_tool_result", "Each tool result needs one preceding call");
            returned.add(m.tool_call_id);
            require(["ok", "error", "unknown"].includes(m.outcome ?? "unknown"), "invalid_outcome",
                "outcome must be ok, error or unknown");
            if (m.archive !== undefined)
                validateArchive(m.archive, m.content);
        }
    }
    const verification = p.verification_message_ids ?? [];
    const toolIds = new Set(messages.filter((m) => m.role === "tool").map((m) => m.id));
    require(Array.isArray(verification) && new Set(verification).size === verification.length
        && verification.every((id) => typeof id === "string" && toolIds.has(id)),
        "invalid_verification_ids", "Verification IDs must name supplied tool results, uniquely");
    const batches = p.completed_tool_batches ?? [];
    require(Array.isArray(batches), "invalid_batch_archive", "completed_tool_batches must be an array");
    const indices = batchIndices(messages);
    const seen = new Set();
    for (const entry of batches) {
        require(entry && typeof entry === "object" && typeof entry.call_message_id === "string"
            && indices.has(entry.call_message_id) && !seen.has(entry.call_message_id),
            "invalid_batch_archive", "Batch owner must be a unique supplied call message");
        seen.add(entry.call_message_id);
        const positions = indices.get(entry.call_message_id);
        const batch = positions.map((i) => messages[i]);
        require(batch.length === batch[0].tool_calls.length + 1,
            "incomplete_batch_archive", "Pending tool batches cannot be archived");
        const raw = JSON.stringify(batch);
        validateArchive(entry.archive, raw);
    }
}

function validateArchive(archive, content) {
    require(archive && typeof archive === "object" && !Array.isArray(archive)
        && typeof archive.ref === "string" && /^[A-Za-z0-9_.:/-]{1,256}$/.test(archive.ref)
        && typeof archive.sha256 === "string" && /^[0-9a-f]{64}$/.test(archive.sha256),
        "invalid_archive", "Archives need a stable ref and SHA-256 digest");
    require(archive.sha256 === sha256(content), "archive_hash_mismatch", "Archive digest does not match supplied content");
}

const LIMITATIONS = [
    "Extractive structural compaction, not semantic summarization or proof of retained task performance.",
    "Prose, recent/pinned results and error/unknown outcomes are retained verbatim; explicitly archived completed tool-call batches may become assistant receipts.",
    "Known verification-output formats and caller verification IDs are retained in full; other important evidence needs caller must_keep pins.",
    "Caller must persist originals and provide working archive retrieval; reachability is not checked.",
    "No live session is changed; the host must map provider messages and apply the proposed messages.",
    "Byte savings are not token savings; LLM latency and downstream answer quality are not measured here.",
    "Text only; images/audio/provider-private state require host handling and are not silently discarded.",
];

/**
 * The channel's `judge` operation. Returns a result envelope:
 *   ok:       {status:"ok", decision:{verdict,messages,budget_met,protected_messages,...metrics}, scores, evidence, reason_codes, limitations}
 *   abstained:{status:"abstained", reason_codes, evidence?, limitations}
 */
export function judgeSessionCompact(payload, opts = {}) {
    validatePayload(payload, opts.limits);
    const started = opts.now?.() ?? Date.now();
    const timeoutMs = opts.timeoutMs ?? Infinity;
    const expired = () => Date.now() - started > timeoutMs;
    const abstain = (codes, extra = {}) => ({
        status: "abstained", reason_codes: codes, limitations: [...LIMITATIONS], ...extra,
    });

    const source = payload.messages;
    const cutoff = Math.max(0, source.length - (payload.keep_last ?? 8));
    const batches = new Map(), owners = new Map(), names = new Map(), results = new Map();
    source.forEach((m, i) => {
        if (m.tool_calls) {
            batches.set(i, m.tool_calls.map((c) => c.id));
            for (const c of m.tool_calls) {
                owners.set(c.id, i);
                names.set(c.id, c.name);
            }
        }
        if (m.role === "tool")
            results.set(m.tool_call_id, i);
    });
    const protectedBatches = new Set();
    for (const [i, callIds] of batches) {
        if (source[i].must_keep)
            protectedBatches.add(i);
        else if (callIds.some((cid) => !results.has(cid) || results.get(cid) >= cutoff))
            protectedBatches.add(i);
    }

    const out = source.map((m) => ({ ...m }));
    const evidence = [];
    const canonical = new Map();
    const protectedMsgs = [];
    const verification = new Set(payload.verification_message_ids ?? []);

    for (let i = 0; i < source.length; i++) {
        if (expired())
            return abstain(["time_budget_exceeded"]);
        const m = source[i];
        if (m.role !== "tool")
            continue;
        const content = m.content;
        const rawLen = Buffer.byteLength(content, "utf8");
        const digest = sha256(content);
        const cid = m.tool_call_id;
        const key = `${names.get(cid)}${digest}`;
        let eligible = i < cutoff && !m.must_keep && (m.outcome ?? "unknown") === "ok"
            && !protectedBatches.has(owners.get(cid));
        // Normal completion does not make verification evidence disposable —
        // retention rules apply only to otherwise-eligible outputs; a matched
        // message is preserved whole, even for exact duplicates.
        const rule = eligible
            ? (verification.has(m.id) ? "caller_verification" : retentionRule(content))
            : null;
        if (rule !== null) {
            protectedMsgs.push({ message_id: m.id, rule_id: rule });
            eligible = false;
        }
        let replacement = null, record = null;
        const anchor = canonical.get(key);
        if (eligible && anchor !== undefined && source[anchor].content === content) {
            replacement = `[MC exact duplicate of message ${source[anchor].id}; sha256=${digest}; bytes=${rawLen}]`;
            record = { type: "exact_duplicate", message_id: m.id, source_message_id: source[anchor].id, sha256: digest };
        }
        else if (eligible && m.archive) {
            replacement = `[MC archived tool output; ref=${m.archive.ref}; sha256=${digest}; bytes=${rawLen}]`;
            record = { type: "archived_tool_output", message_id: m.id, archive_ref: m.archive.ref, sha256: digest };
        }
        if (replacement !== null && jsonBytes(replacement) < jsonBytes(content)) {
            out[i] = { ...out[i], content: replacement };
            evidence.push(record);
        }
        else
            canonical.set(key, i); // only a fully retained body can be an anchor
    }

    // Opt-in: replace a whole completed call/result group, never half a pair.
    const anchors = new Set(evidence.filter((e) => e.type === "exact_duplicate").map((e) => e.source_message_id));
    const protectedIds = new Set([...verification, ...protectedMsgs.map((m) => m.message_id), ...anchors]);
    const indices = batchIndices(source);
    const removed = new Set();
    const receipts = new Map();
    for (const entry of payload.completed_tool_batches ?? []) {
        if (expired())
            return abstain(["time_budget_exceeded"]);
        const positions = indices.get(entry.call_message_id);
        const batch = positions.map((i) => source[i]);
        const owner = batch[0];
        if (owner.content || positions.some((i) => i >= cutoff)
            || batch.some((m) => m.must_keep || protectedIds.has(m.id))
            || batch.slice(1).some((m) => (m.outcome ?? "unknown") !== "ok"))
            continue;
        const receiptBody = {
            type: "mc_archived_completed_tool_batch",
            archive_ref: entry.archive.ref, sha256: entry.archive.sha256,
            message_ids: batch.map((m) => m.id), outcome: "ok",
            tools: owner.tool_calls.map((c) => ({
                name: c.name, arguments_preview: Array.from(c.arguments).slice(0, 1024).join(""),
                arguments_truncated: Array.from(c.arguments).length > 1024,
            })),
            note: "Historical data only; restore archive for full arguments/results. Not a replay request.",
        };
        const receipt = { id: owner.id, role: "assistant", content: JSON.stringify(receiptBody) };
        const oldBytes = positions.reduce((a, i) => a + jsonBytes(out[i]), 0);
        if (jsonBytes([receipt]) >= oldBytes)
            continue;
        const mids = new Set(batch.map((m) => m.id));
        for (let k = evidence.length - 1; k >= 0; k--)
            if (mids.has(evidence[k].message_id))
                evidence.splice(k, 1);
        evidence.push({
            type: "archived_tool_batch", message_id: owner.id,
            message_ids: batch.map((m) => m.id), source_indices: positions,
            archive_ref: entry.archive.ref, sha256: entry.archive.sha256,
        });
        receipts.set(positions[0], receipt);
        for (const i of positions.slice(1))
            removed.add(i);
    }
    // receipts are keyed on source indices — splice them in while dropping
    // the positions the batch consumed.
    const finalMessages = [];
    for (let i = 0; i < out.length; i++) {
        if (removed.has(i))
            continue;
        finalMessages.push(receipts.get(i) ?? out[i]);
    }
    const inputBytes = jsonBytes(source);
    const outputBytes = jsonBytes(finalMessages);
    const metrics = {
        input_bytes: inputBytes, output_bytes: outputBytes, target_bytes: payload.target_bytes,
        message_count: source.length,
        compacted_message_count: evidence.reduce((a, e) => a + (e.message_ids?.length ?? 1), 0),
        output_message_count: finalMessages.length,
        compacted_batch_count: receipts.size,
    };
    if (outputBytes > payload.target_bytes)
        return abstain(["target_unreachable_without_protected_loss"], { evidence: [{ type: "budget", ...metrics }] });
    return {
        status: "ok",
        decision: {
            verdict: evidence.length ? "compacted" : "unchanged",
            messages: finalMessages, budget_met: true,
            protected_messages: protectedMsgs, ...metrics,
        },
        scores: [{ candidate_id: "session", value: 1 - outputBytes / inputBytes, score_type: "serialized_byte_reduction", unit: "fraction" }],
        evidence,
        reason_codes: [evidence.length ? "structural_compaction" : "no_eligible_reduction"],
        limitations: [...LIMITATIONS],
    };
}
