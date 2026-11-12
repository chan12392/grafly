/**
 * Marker-fenced section upsert. Grafly owns exactly the region between the
 * markers; everything else in the file belongs to the user and is preserved.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import safePath from '../util/safe-path.cjs';
export const START = '<!-- grafly:start -->';
export const END = '<!-- grafly:end -->';
/**
 * A brain's rules go in their OWN fenced block, not inside the instruction
 * block above.
 *
 * They have to be separately addressable: the instruction body is static and
 * rewritten by `init`, while rules change whenever the brain does and are
 * refreshed on their own. One pair of markers for both would mean every rules
 * refresh rewrites the instructions too, and `grafly uninstall` could not remove
 * one without the other.
 */
export const BRAIN_START = '<!-- grafly:brain:start -->';
export const BRAIN_END = '<!-- grafly:brain:end -->';
/** Pre-rename fences. Upserts find-and-replace them with the canonical pair so
 * a refreshed block migrates in place; retract strips either spelling. */
const LEGACY_START = '<!-- graft:start -->';
const LEGACY_END = '<!-- graft:end -->';
const LEGACY_BRAIN_START = '<!-- graft:brain:start -->';
const LEGACY_BRAIN_END = '<!-- graft:brain:end -->';
export const GRAFT_MARKERS = { start: START, end: END };
export const BRAIN_MARKERS = { start: BRAIN_START, end: BRAIN_END };
const LEGACY_GRAFT_MARKERS = { start: LEGACY_START, end: LEGACY_END };
const LEGACY_BRAIN_MARKERS = { start: LEGACY_BRAIN_START, end: LEGACY_BRAIN_END };
/** Every managed region grafly may own in a user-owned file. */
export const ALL_MARKERS = [GRAFT_MARKERS, BRAIN_MARKERS, LEGACY_GRAFT_MARKERS, LEGACY_BRAIN_MARKERS];
export function fencedBlock(body, eol = '\n', markers = GRAFT_MARKERS) {
    // Normalize any pre-existing '\r' out of the body first so callers passing
    // a CRLF (or stray-CR) body never get doubled '\r' when eol is '\r\n'.
    const normalizedBody = body.replace(/\r/g, '').replace(/<!--\s*(?:grafly|graft)(?::brain)?:(?:start|end)\s*-->/g, '');
    const block = `${markers.start}\n${normalizedBody.replace(/\s+$/, '')}\n${markers.end}`;
    return eol === '\n' ? block : block.replace(/\n/g, '\r\n');
}
/** The file's dominant line ending: CRLF if any '\r\n' is present, else LF. */
function detectEol(text) {
    return text.includes('\r\n') ? '\r\n' : '\n';
}
/** Index of a marker that sits alone on its own line, or -1. */
function markerLineIndex(lines, marker, from = 0) {
    for (let i = from; i < lines.length; i++) {
        if (lines[i].trim() === marker)
            return i;
    }
    return -1;
}
/** Remove only complete owned sections, leaving other instructions intact. */
export function removeSection(filePath, markers = GRAFT_MARKERS) {
    safePath.assertNoSymlinks(filePath);
    if (!existsSync(filePath))
        return { action: 'unchanged' };
    const text = readFileSync(filePath, 'utf8');
    const eol = detectEol(text);
    const lines = text.split(/\r\n|\n/);
    const candidates = [markers, markers === BRAIN_MARKERS ? LEGACY_BRAIN_MARKERS : LEGACY_GRAFT_MARKERS];
    let removed = false;
    for (const m of candidates) {
        for (;;) {
            const start = markerLineIndex(lines, m.start);
            const end = start < 0 ? -1 : markerLineIndex(lines, m.end, start + 1);
            if (end < 0)
                break;
            lines.splice(start, end - start + 1);
            removed = true;
        }
    }
    const next = lines.join(eol);
    if (!removed)
        return { action: 'unchanged' };
    writeFileSync(filePath, next);
    return { action: 'removed' };
}
export function upsertSection(filePath, body, markers = GRAFT_MARKERS) {
    safePath.assertNoSymlinks(filePath);
    if (!existsSync(filePath)) {
        const block = fencedBlock(body, '\n', markers);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, `${block}\n`);
        return { action: 'created' };
    }
    const text = readFileSync(filePath, 'utf8');
    const eol = detectEol(text);
    // Split on either eol so lines never carry an embedded '\r' — that keeps
    // the marker/content comparison clean and lets us rejoin deliberately with
    // the detected eol instead of relying on '\r' characters riding along
    // inside array elements (which broke down whenever the block-with-no-
    // trailing-'\r' element sat next to a '\n' join, e.g. right after END, or
    // when the block was the entire file).
    const lines = text.split(/\r\n|\n/);
    // Canonical fences win; a pre-rename `graft:` fence is replaced in place,
    // migrating the block instead of appending a duplicate.
    const candidates = [markers, markers === BRAIN_MARKERS ? LEGACY_BRAIN_MARKERS : LEGACY_GRAFT_MARKERS];
    let s = -1, e = -1;
    for (const m of candidates) {
        s = markerLineIndex(lines, m.start);
        e = s === -1 ? -1 : markerLineIndex(lines, m.end, s + 1);
        if (s !== -1 && e !== -1)
            break;
    }
    if (s !== -1 && e !== -1) {
        const current = lines.slice(s, e + 1).join('\n');
        if (current === fencedBlock(body, '\n', markers))
            return { action: 'unchanged' };
        const block = fencedBlock(body, eol, markers);
        const next = [...lines.slice(0, s), ...block.split(eol), ...lines.slice(e + 1)];
        writeFileSync(filePath, next.join(eol));
        return { action: 'replaced' };
    }
    const block = fencedBlock(body, eol, markers);
    const doubleEol = eol + eol;
    const sep = text.endsWith(doubleEol) ? '' : text.endsWith(eol) ? eol : doubleEol;
    writeFileSync(filePath, `${text}${sep}${block}${eol}`);
    return { action: 'appended' };
}
