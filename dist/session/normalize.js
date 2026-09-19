/**
 * Codex rollout JSONL ↔ normalized channel messages, and the apply step that
 * writes a compacted sibling transcript. Non-message events (meta, reasoning,
 * world_state, token_count…) pass through untouched — the compacted file is
 * byte-identical outside replaced tool outputs and consumed batch lines.
 */
import { createHash } from "node:crypto";
import { RequestError } from "./compact.js";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const IDENT = /^[A-Za-z0-9_.:/-]{1,128}$/;
const TEXT_TYPES = new Set(["text", "input_text", "output_text"]);
const fail = (code, detail) => { throw new RequestError(code, detail); };

function textParts(value) {
    if (typeof value === "string") return { text: value, parts: [value], supported: true };
    if (!Array.isArray(value)) return { text: "", parts: [], supported: false };
    const supported = value.every((p) => typeof p === "string"
        || (p && TEXT_TYPES.has(p.type) && typeof p.text === "string"));
    const parts = value.map((p) => typeof p === "string" ? p :
        p && TEXT_TYPES.has(p.type) && typeof p.text === "string" ? p.text : "");
    return { text: parts.join(""), parts, supported };
}

/** Completion of a call item is not proof that its result succeeded. */
function resultOutcome(payload, parts, callStatus) {
    let ok = false, error = callStatus === "failed", pending = false, visited = 0;
    function inspect(value, depth = 0) {
        if (depth > 5 || ++visited > 256) { pending = true; return; }
        if (typeof value === "string") {
            if (/^Script failed\r?\nWall time /u.test(value) || /^Error:/u.test(value)) error = true;
            if (/^Script completed\r?\nWall time [0-9.]+ seconds\r?\nOutput:\r?\n/u.test(value)) ok = true;
            if (/^Script running with cell ID /mu.test(value)) pending = true;
            for (const m of value.matchAll(/^(?:Process exited with code|Exit code\s*:?|exit_code\s*[:=])\s*(-?\d+)\s*$/gmi)) {
                if (Number(m[1]) === 0) ok = true; else error = true;
            }
            const body = value.replace(/^Script (?:completed|failed)\r?\nWall time [0-9.]+ seconds\r?\nOutput:\r?\n/u, "");
            try { const parsed = JSON.parse(body); if (parsed && typeof parsed === "object") inspect(parsed, depth + 1); } catch { /* ordinary text */ }
            return;
        }
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) { for (const item of value) inspect(item, depth + 1); return; }
        if (value.isError === true || value.success === false || value.ok === false
            || value.outcome === "error" || value.status === "failed"
            || (value.error != null && value.error !== false && value.error !== "")) error = true;
        if (value.isError === false || value.success === true || value.ok === true || value.outcome === "ok") ok = true;
        if (Number.isInteger(value.exit_code)) { if (value.exit_code === 0) ok = true; else error = true; }
        if (value.session_id != null && value.exit_code == null) pending = true;
        if (["running", "in_progress", "pending"].includes(value.status)) pending = true;
        // Inspect known result envelopes, not arbitrary user data fields.
        for (const key of ["content", "text", "output", "structuredContent", "result", "value"])
            if (key in value) inspect(value[key], depth + 1);
    }
    inspect(payload);
    for (const part of parts) inspect(part);
    return error ? "error" : pending ? "unknown" : ok ? "ok" : "unknown";
}

/**
 * Normalize one rollout file's lines. Returns {lines, messages, byMessageId} —
 * `byMessageId` maps each normalized message to its source line index so the
 * apply step can patch exactly those lines.
 */
export function normalizeRollout(raw) {
    const lines = raw.split("\n");
    const records = lines.map((line, i) => {
        if (!line.trim()) return null;
        try { return JSON.parse(line); }
        catch { return fail("invalid_rollout", `Invalid JSON at line ${i + 1}`); }
    });
    const messages = [], byMessageId = new Map(), reserved = new Set(), callStatus = new Map();
    const isMessage = (p) => p && ["message", "function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(p.type);
    for (const row of records) {
        const p = row?.payload;
        if (row?.type !== "response_item" || !isMessage(p) || typeof p.id !== "string" || !IDENT.test(p.id)) continue;
        if (reserved.has(p.id)) fail("invalid_message_id", `Duplicate native message ID: ${p.id}`);
        reserved.add(p.id);
    }
    for (const [i, row] of records.entries()) {
        const p = row?.payload;
        if (row?.type !== "response_item" || !isMessage(p)) continue;
        let id = p.id;
        if (typeof id !== "string" || !IDENT.test(id)) {
            id = `mc_line_${i + 1}`;
            while (reserved.has(id)) id += "_";
            reserved.add(id);
        }
        let message;
        if (p.type === "function_call" || p.type === "custom_tool_call") {
            const cid = p.call_id ?? p.id;
            callStatus.set(cid, p.status);
            const args = p.input ?? p.arguments ?? "";
            message = { id, role: "assistant", content: "", tool_calls: [{ id: cid, name: p.name, arguments: typeof args === "string" ? args : "" }] };
            if (typeof args !== "string") message.must_keep = true;
        } else if (p.type.endsWith("call_output")) {
            const content = textParts(p.output);
            message = { id, role: "tool", tool_call_id: p.call_id, content: content.text,
                outcome: resultOutcome(p, content.parts, callStatus.get(p.call_id)) };
            if (!content.supported) message.must_keep = true;
        } else {
            const content = textParts(p.content);
            message = { id, role: p.role, content: content.text };
            if (!content.supported) message.must_keep = true;
        }
        messages.push(message);
        byMessageId.set(id, i);
    }
    return { lines, messages, byMessageId };
}

/**
 * Archive exact changed/deleted raw lines, including multipart shape and CRLF.
 * The manifest restores source positions independently of native message IDs.
 */
export function applyToRollout({ lines, byMessageId }, compactedMessages, originalMessages, archives = new Map()) {
    const original = new Map(originalMessages.map((m) => [m.id, m]));
    const compacted = new Map(compactedMessages.map((m) => [m.id, m]));
    const idByLine = new Map([...byMessageId].map(([id, i]) => [i, id]));
    const out = [], edits = [];
    for (const [i, line] of lines.entries()) {
        const id = idByLine.get(i), before = original.get(id), after = compacted.get(id);
        if (!before || (after && JSON.stringify(before) === JSON.stringify(after))) { out.push(line); continue; }
        if (before.must_keep) fail("protected_loss", `Cannot replace protected message ${id}`);
        let replacement = null;
        if (after) {
            const row = JSON.parse(line), p = row.payload;
            if (before.role === "tool") {
                if (!textParts(p.output).supported) fail("unsupported_content", `Cannot replace non-text result ${id}`);
                p.output = Array.isArray(p.output) ? [{ type: "input_text", text: after.content }] : after.content;
            } else {
                let receipt;
                try { receipt = JSON.parse(after.content); } catch { /* reject below */ }
                if (before.role !== "assistant" || receipt?.type !== "mc_archived_completed_tool_batch")
                    fail("invalid_compaction", `Unexpected replacement for ${id}`);
                const { call_id, name, input, arguments: args, status, ...metadata } = p;
                row.payload = { ...metadata, type: "message", role: "assistant", content: [{ type: "output_text", text: after.content }] };
            }
            replacement = JSON.stringify(row) + (line.endsWith("\r") ? "\r" : "");
        }
        const digest = sha256(line), ref = `${digest}.line`;
        archives.set(ref, line);
        edits.push({ source_index: i, compacted_index: replacement === null ? null : out.length, archive_ref: ref });
        if (replacement !== null) out.push(replacement);
    }
    return { lines: out, archives, manifest: {
        schema: "grafly.session_restore.v1", source_sha256: sha256(lines.join("\n")),
        compacted_sha256: sha256(out.join("\n")), source_line_count: lines.length, edits,
        archives: [...archives].map(([ref, content]) => ({ ref, sha256: sha256(content) })),
    } };
}

/**
 * Verify every archive and reconstruct the exact original. A missing/corrupt
 * archive never produces a partial restored transcript.
 */
export function expandRollout(raw, readArchive, manifest) {
    if (manifest?.schema !== "grafly.session_restore.v1")
        fail("missing_restore_manifest", "Exact restoration requires the manifest from session-compact; legacy text-only archives cannot recover original record shapes");
    if (sha256(raw) !== manifest.compacted_sha256) fail("compacted_hash_mismatch", "Compacted transcript changed since compaction");
    const lines = raw.split("\n");
    if (!Array.isArray(manifest.edits) || !Array.isArray(manifest.archives)
        || !Number.isSafeInteger(manifest.source_line_count) || manifest.source_line_count < lines.length
        || manifest.source_line_count > lines.length + manifest.edits.length)
        fail("invalid_manifest", "Invalid source line count or restoration edits");
    const archives = new Map();
    for (const entry of manifest.archives) {
        if (!entry || !/^[0-9a-f]{64}\.(?:txt|json|line)$/.test(entry.ref)
            || entry.ref.split(".")[0] !== entry.sha256 || archives.has(entry.ref))
            fail("invalid_archive_ref", "Archive references must be unique content-addressed filenames");
        const content = readArchive(entry.ref);
        if (typeof content !== "string") fail("archive_missing", `Missing archive ${entry.ref}`);
        if (sha256(content) !== entry.sha256) fail("archive_hash_mismatch", `Corrupt archive ${entry.ref}`);
        archives.set(entry.ref, content);
    }
    const edits = new Map();
    for (const edit of manifest.edits) {
        if (!edit || !Number.isSafeInteger(edit.source_index) || edit.source_index < 0
            || edit.source_index >= manifest.source_line_count || edits.has(edit.source_index)
            || !archives.has(edit.archive_ref)) fail("invalid_manifest", "Invalid restoration edit");
        edits.set(edit.source_index, edit);
    }
    const out = [];
    let cursor = 0;
    for (let i = 0; i < manifest.source_line_count; i++) {
        const edit = edits.get(i);
        if (!edit) {
            if (cursor >= lines.length) fail("invalid_manifest", "Restoration ran out of lines");
            out.push(lines[cursor++]);
        } else {
            if (edit.compacted_index !== null) {
                if (edit.compacted_index !== cursor || cursor >= lines.length) fail("invalid_manifest", "Replacement position mismatch");
                cursor++;
            }
            out.push(archives.get(edit.archive_ref));
        }
    }
    if (cursor !== lines.length || sha256(out.join("\n")) !== manifest.source_sha256)
        fail("source_hash_mismatch", "Restored transcript does not match the original SHA-256");
    return { lines: out, restored: manifest.edits.map((e) => e.source_index + 1), failed: [] };
}
