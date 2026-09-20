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

export function shouldRetrievePrompt(value) {
    const prompt = String(value ?? '').trim();
    if (!prompt) return false;
    // Preserve short identifiers and mixed requests such as "Thanks, fix foo()".
    if (CODE_ANCHOR.test(prompt) || IDENTIFIER.test(prompt)) return true;
    const clauses = prompt.split(/[.!?。！？\r\n]+/u).map(part => part.trim()).filter(Boolean);
    return !clauses.length || !clauses.every(clause =>
        CHAT_ONLY.test(clause) || TOOL_CHAT.some(pattern => pattern.test(clause)));
}
