/** Local file lifecycle for the MC judge. No live-session replacement or LLM. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, linkSync, unlinkSync, openSync, fsyncSync, closeSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { judgeSessionCompact, RequestError } from "./compact.js";
import { normalizeRollout, applyToRollout, expandRollout } from "./normalize.js";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), "utf8");
const clean = (messages) => messages.map(({ archive, ...m }) => m);
const fail = (code, detail) => { throw new RequestError(code, detail); };

function integer(value, fallback, minimum, name) {
    if (value === undefined) return fallback;
    if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum)
        fail("invalid_budget", `${name} must be an integer >= ${minimum}`);
    return Number(value);
}

export function compactRollout(raw, options = {}) {
    const normalized = normalizeRollout(raw), messages = normalized.messages;
    const keepLast = integer(options.keepLast, 8, 0, "--keep-last");
    const ids = new Set(messages.map((m) => m.id)), pins = new Set(options.pin ?? []);
    for (const id of pins) if (!ids.has(id)) fail("invalid_pin", `Unknown message ID: ${id}`);
    for (const m of messages) if (pins.has(m.id)) m.must_keep = true;
    const normalizedInputBytes = bytes(clean(messages));
    const cutoff = Math.max(0, messages.length - keepLast), candidates = new Map();
    function archive(content, extension) {
        const digest = sha256(content), ref = `${digest}.${extension}`;
        candidates.set(ref, content);
        return { ref, sha256: digest };
    }
    messages.forEach((m, i) => {
        if (i < cutoff && m.role === "tool" && m.outcome === "ok" && !m.must_keep && Buffer.byteLength(m.content) > 300)
            m.archive = archive(m.content, "txt");
    });
    const results = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m]));
    const completed = [];
    if (options.batches !== false) for (const owner of messages) {
        if (!owner.tool_calls) continue;
        const returns = owner.tool_calls.map((c) => results.get(c.id));
        if (returns.some((m) => !m)) continue;
        const members = new Set([owner, ...returns]);
        const batch = messages.filter((m) => members.has(m));
        completed.push({ call_message_id: owner.id, archive: archive(JSON.stringify(batch), "json") });
    }
    const target = integer(options.targetBytes, bytes(messages), 1, "--target-bytes");
    const payload = { messages, target_bytes: target, keep_last: keepLast,
        verification_message_ids: options.verify ?? [] };
    const individual = judgeSessionCompact(payload);
    const candidate = completed.length ? judgeSessionCompact({ ...payload, completed_tool_batches: completed }) : individual;
    function apply(result) {
        const archives = new Map();
        for (const evidence of result.evidence) if (evidence.archive_ref) {
            const content = candidates.get(evidence.archive_ref);
            if (content === undefined) fail("archive_missing", "Judge selected an unavailable archive");
            archives.set(evidence.archive_ref, content);
        }
        const applied = applyToRollout(normalized, result.decision.messages, messages, archives);
        return { result, applied, compacted: applied.lines.join("\n") };
    }
    if (individual.status !== "ok" && candidate.status !== "ok") return { result: candidate };
    let selected = apply(candidate.status === "ok" ? candidate : individual);
    if (candidate !== individual && candidate.status === "ok" && individual.status === "ok") {
        const baseline = apply(individual);
        // Archive metadata is bookkeeping, not useful context. A receipt must
        // not grow either the actual rollout or the messages without metadata.
        if (bytes(clean(candidate.decision.messages)) > bytes(clean(individual.decision.messages))
            || Buffer.byteLength(selected.compacted) > Buffer.byteLength(baseline.compacted))
            selected = baseline;
    }
    const { result, applied, compacted } = selected;
    // Exercise the same full restoration path before publishing any output.
    expandRollout(compacted, (ref) => applied.archives.get(ref), applied.manifest);
    const normalizedOutputBytes = bytes(clean(result.decision.messages));
    const inputBytes = Buffer.byteLength(raw), outputBytes = Buffer.byteLength(compacted);
    result.measurements = {
        normalized_input_bytes: normalizedInputBytes, normalized_output_bytes: normalizedOutputBytes,
        normalized_reduction_fraction: 1 - normalizedOutputBytes / normalizedInputBytes,
        rollout_input_bytes: inputBytes, rollout_output_bytes: outputBytes,
        rollout_reduction_fraction: inputBytes ? 1 - outputBytes / inputBytes : 0,
        archive_bytes: [...applied.archives.values()].reduce((sum, content) => sum + Buffer.byteLength(content), 0),
        manifest_bytes: Buffer.byteLength(JSON.stringify(applied.manifest, null, 2) + "\n"),
        exact_restore_verified: true,
    };
    return { result, applied, compacted };
}

function readUtf8(path) {
    const buffer = readFileSync(path), raw = buffer.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(buffer)) fail("unsupported_encoding", "Input must be valid UTF-8");
    return raw;
}

/** Publish a complete file exclusively; never replace existing user files. */
function publish(path, content) {
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    const fd = openSync(temporary, "wx");
    try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { linkSync(temporary, path); }
    finally { unlinkSync(temporary); }
}

export function compactFile(transcript, options = {}) {
    const path = resolve(transcript), raw = readUtf8(path);
    const run = compactRollout(raw, options);
    if (run.result.status !== "ok") return { schema: "grafly.session_compact.v1", ...run.result };
    const out = resolve(options.out ?? `${path}.compacted.jsonl`);
    const archiveDir = `${out}.archive`, manifest = `${out}.manifest.json`;
    for (const target of [out, archiveDir, manifest]) if (existsSync(target))
        fail("output_exists", `Refusing to overwrite ${target}; choose a new --out path`);
    if (sha256(readFileSync(path)) !== run.applied.manifest.source_sha256)
        fail("source_changed", "Source transcript changed while preparing compaction; retry on a frozen copy");
    mkdirSync(archiveDir);
    for (const [ref, content] of run.applied.archives) publish(join(archiveDir, ref), content);
    // Read archives back before exposing the compacted transcript.
    expandRollout(run.compacted, (ref) => readUtf8(join(archiveDir, ref)), run.applied.manifest);
    publish(manifest, JSON.stringify(run.applied.manifest, null, 2) + "\n");
    publish(out, run.compacted);
    return { schema: "grafly.session_compact.v1", out, archiveDir, manifest, ...run.result };
}

export function expandFile(transcript, options = {}) {
    const path = resolve(transcript), raw = readUtf8(path);
    const manifestPath = `${path}.manifest.json`, archiveDir = `${path}.archive`;
    if (!existsSync(manifestPath)) fail("missing_restore_manifest", "This file has no exact-restore manifest; recompact its original with the current Grafly CLI");
    if (lstatSync(archiveDir).isSymbolicLink()) fail("invalid_archive_ref", "Archive directory must not be a symbolic link");
    const manifest = JSON.parse(readUtf8(manifestPath));
    const expanded = expandRollout(raw, (ref) => {
        const file = join(archiveDir, ref); // ref was validated before this callback
        if (!existsSync(file)) return null;
        if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) fail("invalid_archive_ref", "Archive must be a regular file");
        return readUtf8(file);
    }, manifest);
    const out = resolve(options.out ?? `${path.replace(/\.compacted\.jsonl$/, "")}.restored.jsonl`);
    if (existsSync(out)) fail("output_exists", `Refusing to overwrite ${out}; choose a new --out path`);
    publish(out, expanded.lines.join("\n"));
    return { out, restored: expanded.restored.length, source_sha256: manifest.source_sha256, exact_restore_verified: true };
}
