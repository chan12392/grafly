import { createHash } from "node:crypto";

const MAX_RULES_PER_MINE = 60;
const MINE_TIMEOUT_MS = 180_000;

/* ------------------------------------------------------------------ mining */

/** The prompt: mine durable decisions, anchor each to a real symbol id. */
function miningPrompt(digest, symbols) {
    const sys = [
        "You are the mining stage of a repository 'brain'. Read the digest of a",
        "repo's history — commit messages, pull-request discussion, and stated",
        "docs — and extract the durable DECISIONS and CONVENTIONS the team made:",
        "things a code reader cannot see but must not violate.",
        "",
        "Rules for the rules:",
        "- Each rule is ONE sentence, imperative or declarative, about THIS repo.",
        "- Anchor every rule to exactly one symbol id from the SYMBOLS list — the",
        "  symbol the rule governs. If nothing fits, drop the rule.",
        "- Prefer stated sources (docs, AGENTS/CLAUDE files, CODEOWNERS) over",
        "  threads over commit messages. Ignore style nits, version bumps,",
        "  housekeeping, and anything a reader sees in the code anyway.",
        `- At most ${MAX_RULES_PER_MINE} rules. Quality over coverage.`,
        "",
        "Answer with a JSON object only:",
        '{"anchors":[{"symbol":"<symbol id>","rule":"<one sentence>","source":"<sha or PR number>"}]}',
    ].join("\n");

    const sym = symbols.map((s) => `${s.id} ${s.kind} ${s.name} (${s.path})`).join("\n");
    const commits = digest.commits.map((c) =>
        `commit ${c.sha.slice(0, 10)}\n  ${c.subject}${c.body ? "\n  " + c.body.slice(0, 500) : ""}${c.symbols?.length ? "\n  touches: " + c.symbols.slice(0, 8).join(",") : ""}`
    ).join("\n");
    const threads = digest.threads.map((t) =>
        `thread #${t.number} ${t.title}${t.body ? "\n  " + t.body.slice(0, 800) : ""}` +
        (t.comments?.length ? "\n  comments: " + t.comments.map((c) => c.body.slice(0, 400)).join(" | ").slice(0, 1500) : "")
    ).join("\n");
    const sources = (digest.sources ?? []).map((s) => `[${s.kind ?? "source"}] ${s.text ?? JSON.stringify(s).slice(0, 600)}`).join("\n");

    const user = [
        `REPO: ${digest.owner ? digest.owner + '/' : ''}${digest.name} (default branch ${digest.default_branch})`,
        "",
        "SYMBOLS (id kind name path):", sym || "(none)",
        "",
        "COMMITS:", commits || "(none)",
        "",
        "THREADS:", threads || "(none)",
        "",
        "STATED SOURCES:", sources || "(none)",
    ].join("\n");

    // Keep the request inside a sane context: trim sections from the tail.
    const CAP = 120_000;
    return { sys, user: user.length > CAP ? user.slice(0, CAP) + "\n…(truncated)" : user };
}

/** source_url for an anchor, built from the digest's own metadata. */
function sourceUrl(digest, ref) {
    if (!ref || !digest.owner || !digest.name) return undefined;
    const base = `https://github.com/${digest.owner}/${digest.name}`;
    const r = String(ref).replace(/^#/, "");
    if (/^[0-9a-f]{6,40}$/i.test(r)) return `${base}/commit/${r}`;
    if (/^\d+$/.test(r)) return `${base}/pull/${r}`;
    return undefined;
}

/** LLM → validated rules. Fingerprints come from the digest, not the model. */
export async function mineRules(digest, llm) {
    const fingerprints = new Map((digest.symbols ?? []).map((s) => [s.id, s.fingerprint ?? ""]));
    const { sys, user } = miningPrompt(digest, digest.symbols ?? []);
    let content;
    if (typeof llm.create === 'function') {
        const response = await llm.create({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxTokens: 8192 });
        content = response.text;
    } else {
        const res = await fetch(`${llm.url}/chat/completions`, {
            method: "POST",
            headers: { authorization: `Bearer ${llm.key}`, "content-type": "application/json" },
            body: JSON.stringify({
                model: llm.model,
                messages: [{ role: "system", content: sys }, { role: "user", content: user }],
                temperature: 0.2,
            }),
            signal: AbortSignal.timeout(MINE_TIMEOUT_MS),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
        content = JSON.parse(text).choices?.[0]?.message?.content ?? "";
    }
    const json = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1));
    if (!Array.isArray(json.anchors) || json.anchors.some((a) =>
        !a || typeof a.symbol !== "string" || !a.symbol.trim() || typeof a.rule !== "string" || !a.rule.trim()))
        throw new Error("Invalid mining response: anchors must be an array of symbol/rule strings");
    const seen = new Set();
    return json.anchors
        .filter((a) => a?.symbol && a?.rule && fingerprints.has(a.symbol))
        .filter((a) => !seen.has(a.rule.trim()) && seen.add(a.rule.trim()))
        .slice(0, MAX_RULES_PER_MINE)
        .map((a) => ({
            // Deterministic id: a re-mine that emits the same rule lands on the
            // same slot, so approval state survives instead of duplicating.
            rule_id: `m_${createHash("sha256").update(`${a.symbol}\n${a.rule.trim()}`).digest("hex").slice(0, 16)}`,
            symbol: a.symbol,
            fingerprint: fingerprints.get(a.symbol),
            rule: a.rule.trim(),
            source_url: sourceUrl(digest, a.source),
        }));
}
