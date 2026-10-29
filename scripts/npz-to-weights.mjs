#!/usr/bin/env node
/**
 * npz → weights.json converter — the retraining artifact's path into the
 * circuit. A trainer emits an .npz with `features` (string array of feature
 * names) and `linear` (the learned weight for each); this turns it into the
 * drop-in artifact judge.js loads (or GRAFLY_WEIGHTS points at).
 *
 *   node scripts/npz-to-weights.mjs model.npz                 → JSON to stdout
 *   node scripts/npz-to-weights.mjs model.npz -o weights.json → write artifact
 *   node scripts/npz-to-weights.mjs model.npz --check         → validate only
 *   --abstain N     override abstain_gap (npz scalar `abstain`/`abstain_gap`
 *                   wins over the built-in default, --abstain wins over both)
 *   --map file.json rename incoming feature names: {"npz_name": "judge_key"}
 *
 * Warnings, not silence, for schema drift: a weight whose name the judge
 * never emits is dead; a judge feature the npz lacks scores 0. Both are
 * reported — the artifact is written anyway (lossless), the operator decides.
 *
 * Dependency-free: .npz is a zip of .npy members; zlib + a central-directory
 * walk covers stored/deflate entries, and the .npy v1/v2 header is a Python
 * dict literal we only need descr/shape from.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { basename } from "node:path";
import { FEATURE_KEYS } from "../dist/circuit/judge.js";

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Minimal zip reader → Map(name → Buffer). Handles stored + deflate. */
function unzip(buf) {
    // EOCD is the last fixed-size record; scan back through the comment area.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0)
        throw new Error("not a zip file (no end-of-central-directory record)");
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const out = new Map();
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== CDIR_SIG)
            throw new Error(`bad central directory entry ${i}`);
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOff = buf.readUInt32LE(p + 42);
        const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
        if (buf.readUInt32LE(localOff) !== LOCAL_SIG)
            throw new Error(`bad local header for ${name}`);
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(dataStart, dataStart + compSize);
        out.set(name, method === 0 ? Buffer.from(raw)
            : method === 8 ? inflateRawSync(raw)
            : (() => { throw new Error(`unsupported compression method ${method} for ${name}`); })());
        p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}

/** Parse one .npy member → {descr, shape, data:Array}. Supports 1-D numeric
 * and fixed-width string dtypes — the only shapes a weight artifact needs. */
function parseNpy(buf) {
    if (buf.length < 10 || buf.toString("latin1", 0, 6) !== "\x93NUMPY")
        throw new Error("not an .npy member (bad magic)");
    const major = buf[6];
    const headerLen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
    const headerOff = major === 1 ? 10 : 12;
    const header = buf.toString("latin1", headerOff, headerOff + headerLen);
    const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
    const fortran = /'fortran_order'\s*:\s*True/.test(header);
    const shape = (/'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1] ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean).map(Number);
    if (!descr)
        throw new Error(`unparseable .npy header: ${header}`);
    if (shape.length > 1)
        throw new Error(`only 1-D arrays supported, got shape (${shape})${fortran ? " fortran_order" : ""}`);
    const n = shape[0] ?? 1; // shape () = 0-d scalar → single value
    const body = buf.subarray(headerOff + headerLen);
    const m = /^<([fiu])(\d)$/.exec(descr);
    if (m) {
        const kind = m[1], size = Number(m[2]);
        if (body.length < n * size)
            throw new Error(`.npy body short: ${body.length} < ${n}×${size}`);
        const data = new Array(n);
        for (let i = 0; i < n; i++) {
            const o = i * size;
            data[i] = kind === "f" && size === 4 ? body.readFloatLE(o)
                : kind === "f" && size === 8 ? body.readDoubleLE(o)
                : kind === "i" && size === 4 ? body.readInt32LE(o)
                : kind === "i" && size === 8 ? Number(body.readBigInt64LE(o))
                : kind === "u" && size === 4 ? body.readUInt32LE(o)
                : kind === "u" && size === 8 ? Number(body.readBigUInt64LE(o))
                : kind === "i" && size === 1 ? body.readInt8(o)
                : kind === "u" && size === 1 ? body.readUInt8(o)
                : (() => { throw new Error(`unsupported dtype ${descr}`); })();
        }
        return { descr, shape, data };
    }
    const s = /^[<>=|]?[US](\d+)$/.exec(descr); // <U17 unicode, |S20 bytes
    if (s) {
        const width = Number(s[1]);
        const isU = descr.includes("U");
        const stride = isU ? width * 4 : width;
        const data = new Array(n);
        for (let i = 0; i < n; i++) {
            const o = i * stride;
            let str = "";
            if (isU)
                for (let c = 0; c < width; c++) {
                    const cp = body.readUInt32LE(o + c * 4);
                    if (cp === 0) break;
                    str += String.fromCodePoint(cp);
                }
            else
                str = body.toString("latin1", o, o + width).replace(/\0+$/, "");
            data[i] = str;
        }
        return { descr, shape, data };
    }
    throw new Error(`unsupported dtype ${descr}`);
}

function fail(msg) {
    console.error(`✗ ${msg}`);
    process.exit(1);
}

const args = process.argv.slice(2);
const positional = [];
let out = null, check = false, abstainOverride = null, mapPath = null;
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o" || a === "--out") out = args[++i];
    else if (a === "--check") check = true;
    else if (a === "--abstain") abstainOverride = Number(args[++i]);
    else if (a === "--map") mapPath = args[++i];
    else if (a.startsWith("-")) fail(`unknown flag ${a}`);
    else positional.push(a);
}
const input = positional[0];
if (!input)
    fail("usage: npz-to-weights.mjs <model.npz> [-o weights.json] [--check] [--abstain N] [--map map.json]");
if (abstainOverride !== null && !Number.isFinite(abstainOverride))
    fail("--abstain must be a number");

let members;
try {
    members = unzip(readFileSync(input));
}
catch (err) {
    fail(`${input}: ${err.message}`);
}
const arrays = new Map();
for (const [name, buf] of members) {
    if (!name.endsWith(".npy"))
        continue;
    try {
        arrays.set(name.slice(0, -4), parseNpy(buf));
    }
    catch (err) {
        console.error(`⚠ ${name}: ${err.message} — skipped`);
    }
}
let features = arrays.get("features")?.data;
if ((!Array.isArray(features) || typeof features[0] !== "string") && Array.isArray(arrays.get("features_json")?.data)) {
    try {
        const parsed = JSON.parse(Buffer.from(arrays.get("features_json").data).toString("utf8"));
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string"))
            features = parsed;
    }
    catch { /* validated below */ }
}
const linear = (arrays.get("linear") ?? arrays.get("weights") ?? arrays.get("coef"))?.data;
if (!Array.isArray(features) || typeof features[0] !== "string")
    fail("npz has no usable `features` or `features_json` feature-name list");
if (!Array.isArray(linear) || typeof linear[0] !== "number")
    fail("npz has no `linear`/`weights`/`coef` numeric array — nothing to convert");
if (!linear.every((v) => Number.isFinite(v)))
    fail("weight array contains non-finite values");
if (features.length !== linear.length)
    fail(`features (${features.length}) and linear (${linear.length}) length mismatch`);

const renames = mapPath ? JSON.parse(readFileSync(mapPath, "utf8")) : {};
const weights = {};
const known = new Set(FEATURE_KEYS);
for (let i = 0; i < features.length; i++) {
    const raw = features[i];
    const name = renames[raw] ?? raw;
    if (name in weights)
        console.error(`⚠ duplicate feature name "${name}" — later value wins`);
    weights[name] = linear[i];
    if (!known.has(name))
        console.error(`⚠ "${name}"${renames[raw] ? ` (mapped from ${raw})` : ""} is not a judge feature — dead weight, kept for provenance`);
}
for (const k of FEATURE_KEYS)
    if (!(k in weights))
        console.error(`⚠ judge feature "${k}" absent from npz — will score 0`);

const npzAbstain = (arrays.get("abstain_gap") ?? arrays.get("abstain"))?.data?.[0];
const abstain = abstainOverride ?? (Number.isFinite(npzAbstain) ? npzAbstain : 0.5);
if (!Number.isFinite(abstain) || abstain <= 0)
    fail("abstain threshold must be a positive calibrated value");
const artifact = {
    version: 1,
    source: `npz:${basename(input)}`,
    converted_at: new Date().toISOString(),
    abstain_gap: abstain,
    weights,
};

if (check) {
    const n = Object.keys(weights).length;
    console.log(`ok — ${n} weights (${Object.keys(weights).filter((k) => known.has(k)).length} live, ${n - Object.keys(weights).filter((k) => known.has(k)).length} dead), abstain_gap ${abstain}`);
}
else if (out) {
    writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");
    console.log(`✓ ${out} — ${Object.keys(weights).length} weights, abstain_gap ${abstain} (set GRAFLY_WEIGHTS to use it)`);
}
else {
    process.stdout.write(JSON.stringify(artifact, null, 2) + "\n");
}
