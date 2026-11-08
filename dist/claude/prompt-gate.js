// A cheap pre-retrieval gate, not a semantic classifier. Only recognizable
// conversation is skipped; uncertain prompts, including short ones, retrieve.
const CODE_ANCHOR = /`[^`]+`|\b[\w$]+\s*\([^)]*\)|\b[\w.-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|cpp|h|json|toml|ya?ml|md|sql|sh|ps1|cjs)\b|(?:^|\s)(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])\S+|\b(?:TypeError|ReferenceError|SyntaxError|E[A-Z]{3,})\b/;
const IDENTIFIER = /\b[a-z][a-z\d]*[A-Z][A-Za-z\d]*\b|\b[A-Za-z$][\w$]*_[\w$]+\b/;
const CHAT_ONLY = /^(?:(?:yes|no|ok(?:ay)?|thanks(?: a lot| for (?:the )?(?:help|explanation))?|thank you(?: for (?:the )?(?:help|explanation))?|please|go ahead|continue|sounds good|got it|hello|hi|good (?:morning|evening)|how (?:is it going|are you)|any updates?|what(?:'s| is) the (?:status|progress)|are you (?:done|still working)|응|네|아니|알겠어(?:요)?|알겠습니다|좋아(?:요)?|고마워(?:요)?|감사합니다|수고했어(?:요)?|설명 고마워(?:요)?|이해했어(?:요)?|그대로 진행해(?:줘|주세요)?|계속 진행해(?:줘|주세요)?|진행해(?:줘|주세요)?|안녕(?:하세요)?|지금 (?:어디까지|어느 정도) (?:됐어|진행됐어|했어)(?:요)?|작업은 (?:잘 되고 있어|어디까지 됐어)(?:요)?|아직 작업 중이야|다 끝났어(?:요)?)(?:[\s,.!?~。！？]+|$))+$/i;
// Match a whole conversational clause. A substring like "save tokens" must
// never suppress an attached implementation request or a repository question.
const TOOL_CHAT = [
    /^(?:what|which) tools? do you use (?:most(?: often| frequently)?|the most)(?: (?:during|in) your work)?$/i,
    /^(?:can|would|will|does) grafly (?:reduce|save) (?:tool calls|tokens)$/i,
    /^(?:(?:너|네)가\s*(?:작업하면서\s*)?)?(?:(?:가장|제일)\s*많이\s*쓰는|자주\s*(?:쓰는|사용하는))\s*(?:tools?|도구|툴)(?:은|는)?\s*뭐(?:야|예요|가\s*있어)$/i,
    /^grafly를\s*(?:쓰면|사용하면)\s*(?:tool\s*calls?|토큰)(?:이|가)?\s*(?:얼마나\s*)?줄어들(?:까|겠네|긴할텐데)$/i,
];

/** True when the prompt carries code-shaped terms (call, path, file
 * extension, error literal, or identifier). Stricter than
 * {@link shouldRetrievePrompt}: that gate only skips recognizable
 * conversation, so a plain-prose prompt still passes it — fine inside one
 * indexed repo where the score gate decides, but at a multi-project home
 * workspace a prose prompt ranks against every child graph at once and the
 * "starting points" it injects are cross-repo noise. Home/workspace callers
 * require this on top of shouldRetrievePrompt; repo callers do not. */
export function hasCodeTerms(value) {
    const prompt = String(value ?? '').trim();
    return CODE_ANCHOR.test(prompt) || IDENTIFIER.test(prompt);
}

const TERM_PATTERNS = [
    /\b[a-z][a-z\d]*[A-Z][A-Za-z\d]*\b/g, // camelCase identifier
    /\b[A-Za-z$][\w$]*_[\w$]+\b/g, // snake_case identifier
    /\b[\w$]+(?=\s*\()/g, // call target: foo(
    /\b(?:[\w.@-]+[\\/])*[\w.@-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|cpp|h|json|toml|ya?ml|md|sql|sh|ps1|cjs)\b/g, // file.ext, keeping its path prefix so the anchor check can require a directory suffix
    /\b(?:[A-Z][A-Za-z]*Error|E[A-Z]{3,})\b/g, // error literals
];
/** The code-shaped terms a prompt names — identifiers, call targets, file
 * names, error literals. Plain prose words never qualify: they collide with
 * every corpus (a directive like "run `orca … check --run run_x`" names only
 * `run_x`, not `run`/`check`). A backticked span that is itself one identifier
 * (`login`) counts — the user explicitly code-quoted it — but words inside a
 * multi-word command span do not. */
export function codeTermsOf(value) {
    const prompt = String(value ?? '');
    const terms = new Set();
    for (const re of TERM_PATTERNS)
        for (const m of prompt.matchAll(re))
            terms.add(m[0]);
    for (const m of prompt.matchAll(/`([^`]+)`/g)) {
        const inner = m[1].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(inner))
            terms.add(inner);
    }
    return terms;
}

const termNorm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
/** True when the hit's symbol name or file path IS one of the prompt's code
 * terms (normalized: case and separators ignored). A slash-carrying term may
 * also match a pointer suffix ('src/auth.js' → 'project/src/auth.js'). This is
 * the workspace anchor rule: a federated pack earns its injection only when a
 * hit is literally the thing the prompt named — fuzzy neighbours like
 * `checkSize` for `run_x` or `LiveMaskGraph` for `loadGraph` don't count. */
export function hitAnchoredToTerms(hit, terms) {
    const head = String(hit?.name ?? String(hit?.title ?? '').split('·')[0]).trim();
    const symbol = termNorm(head.split(':')[0]);
    const pointer = String(hit?.pointer ?? '').replace(/\\/g, '/').replace(/:L?\d+(?:-L?\d+)?(?:,.*)?$/, '');
    const base = pointer.split('/').pop() ?? '';
    const baseNorm = termNorm(base), stemNorm = termNorm(base.replace(/\.[^.]+$/, ''));
    for (const t of terms) {
        const nt = termNorm(t);
        if (nt && (nt === symbol || nt === baseNorm || nt === stemNorm))
            return true;
        const pathTerm = t.replace(/\\/g, '/');
        if (pathTerm.includes('/') && pointer.toLowerCase().endsWith(`/${pathTerm.toLowerCase()}`))
            return true;
    }
    return false;
}

// A turn that is nothing but host notifications carries no user query; the
// paths and file names their bodies quote must not trigger retrieval.
const NOTIFICATION_ONLY = /^(?:\s*<task-notification>(?:(?!<\/?task-notification>)[\s\S])*<\/task-notification>)+\s*$/;

export function shouldRetrievePrompt(value) {
    const prompt = String(value ?? '').trim();
    if (!prompt) return false;
    if (NOTIFICATION_ONLY.test(prompt)) return false;
    // Preserve short identifiers and mixed requests such as "Thanks, fix foo()".
    if (hasCodeTerms(prompt)) return true;
    const clauses = prompt.split(/[.!?。！？\r\n]+/u).map(part => part.trim()).filter(Boolean);
    return !clauses.length || !clauses.every(clause =>
        CHAT_ONLY.test(clause) || TOOL_CHAT.some(pattern => pattern.test(clause)));
}
