const SYSTEM_PROMPT = `You document source code for a team knowledge base. Given one source file, write a compact plain-English summary covering:
1. The purpose of the file — what it exists to do.
2. The key exported functions/classes/types and what each is for.
3. Important dependencies: internal modules it builds on, external libraries or services it talks to.
4. Notable design decisions, constraints, or gotchas evident in the code.

Write 3-8 sentences of flowing prose. Name concrete identifiers (modules, classes, services) so they can become graph entities. No code blocks, no line-by-line narration, no filler.`;
/** Cap the code sent per file so a single giant file can't blow the context. */
const MAX_CODE_CHARS = 24_000;
function userContent(code, path) {
    const clipped = code.length > MAX_CODE_CHARS
        ? `${code.slice(0, MAX_CODE_CHARS)}\n… (truncated at ${MAX_CODE_CHARS} characters)`
        : code;
    return `File: ${path}\n\n${clipped}`;
}
/** Summarizer backed by any {@link ChatModel} (a plain-text completion). */
export class ChatSummarizer {
    model;
    constructor(model) {
        this.model = model;
    }
    async summarize(code, opts) {
        const res = await this.model.create({
            temperature: 0,
            maxTokens: 2048,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userContent(code, opts.path) },
            ],
        });
        return res.text.trim();
    }
}
