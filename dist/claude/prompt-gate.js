// A cheap pre-retrieval gate, not a semantic classifier. Only recognizable
// conversation is skipped; uncertain substantive prompts retain retrieval.
const MIN_PROMPT_CHARS = 12;
const CODE_ANCHOR = /`[^`]+`|\b[\w$]+\s*\([^)]*\)|\b[\w.-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|cpp|h|json|toml|ya?ml|md|sql|sh|ps1|cjs)\b|(?:^|\s)(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])\S+|\b(?:TypeError|ReferenceError|SyntaxError|E[A-Z]{3,})\b/;
const IDENTIFIER = /\b[a-z][a-z\d]*[A-Z][A-Za-z\d]*\b|\b[A-Za-z$][\w$]*_[\w$]+\b/;
const CODE_SUBJECT = /\b(?:code|function|class|module|file|bug|error|test|hook|implementation|caller|import|dependency|stack|component)\b|코드|함수|클래스|모듈|파일|버그|오류|테스트|훅|구현|호출|의존|컴포넌트/i;
const CODE_ACTION = /\b(?:find|locate|search|trace|explain|investigate|fix|debug|change|update|add|remove|implement|test|why|where|how)\b|찾|검색|추적|조사|설명|고쳐|고치|수정|바꿔|추가|삭제|구현|왜|어디|어떻게|확인|해봐|해볼/i;
const CHAT_ONLY = /^(?:(?:yes|no|ok(?:ay)?|thanks(?: a lot| for (?:the )?(?:help|explanation))?|thank you(?: for (?:the )?(?:help|explanation))?|please|go ahead|continue|sounds good|got it|hello|hi|good (?:morning|evening)|how (?:is it going|are you)|any updates?|what(?:'s| is) the (?:status|progress)|are you (?:done|still working)|응|네|아니|알겠어(?:요)?|알겠습니다|좋아(?:요)?|고마워(?:요)?|감사합니다|수고했어(?:요)?|설명 고마워(?:요)?|이해했어(?:요)?|그대로 진행해(?:줘|주세요)?|계속 진행해(?:줘|주세요)?|진행해(?:줘|주세요)?|안녕(?:하세요)?|지금 (?:어디까지|어느 정도) (?:됐어|진행됐어|했어)(?:요)?|작업은 (?:잘 되고 있어|어디까지 됐어)(?:요)?|아직 작업 중이야|다 끝났어)(?:[\s,.!?~。！？]+|$))+$/i;
const TOOL_META = /\b(?:tool(?:s|\s+calls?)?|tokens?|grafly|codex)\b|도구|툴|토큰/i;
const TOOL_QUESTION = /(?:가장|제일)\s*많이\s*쓰|자주\s*(?:쓰|사용)|얼마나\s*(?:줄|아끼|절약)|(?:tool\s*call|토큰|도구 호출).*(?:줄어|줄일|아낄|절약)|\b(?:which|what)\s+tools?\b.*\b(?:use|most)\b|\b(?:reduce|save|fewer)\b.*\b(?:tool calls?|tokens?)\b/i;

export function shouldRetrievePrompt(value) {
    const prompt = String(value ?? '').trim();
    if (!prompt) return false;
    // Preserve short identifiers and mixed requests such as "Thanks, fix foo()".
    if (CODE_ANCHOR.test(prompt) || IDENTIFIER.test(prompt) ||
        (CODE_SUBJECT.test(prompt) && CODE_ACTION.test(prompt))) return true;
    if (CHAT_ONLY.test(prompt)) return false;
    // A meta question may also contain a task without an obvious code noun.
    if (TOOL_META.test(prompt) && TOOL_QUESTION.test(prompt) && !CODE_ACTION.test(prompt)) return false;
    return prompt.length >= MIN_PROMPT_CHARS;
}
