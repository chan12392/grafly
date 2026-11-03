/**
 * Provider-neutral chat transport.
 *
 * Every LLM call in graft — the engine's single-shot summarize/synthesize/crux
 * ops, and any multi-turn tool-use loop built on top — goes through one interface,
 * {@link ChatModel}. Adapters translate this neutral shape to a concrete SDK
 * (OpenAI-compatible or native Anthropic). Nothing above this layer knows which
 * provider is in play, so adding a provider is a new adapter, never a change to
 * a call site.
 *
 * The design carries three affordances that let a single interface serve the
 * multi-turn loop as cleanly as a one-shot call:
 *   - {@link ChatResponse.assistant} — a ready-to-append assistant message, so a
 *     caller continues a conversation without touching provider shapes.
 *   - {@link Message.providerRaw} — opaque verbatim replay of a message the same
 *     adapter produced (preserves Anthropic thinking-block signatures, which must
 *     be echoed back unchanged).
 *   - {@link Usage} normalized to uncached-input, so token accounting is identical
 *     across providers.
 */
/**
 * How many times the transport retries a failed request before the error reaches
 * the caller. Both SDKs retry only what is worth retrying (429 and 5xx, honouring
 * `Retry-After`) with exponential backoff, so this is the knob that separates a
 * transient rate limit from a real failure — #127 lost whole files to the first
 * 429 a shared gateway threw. Env-overridable because a metered corporate gateway
 * may want fewer, and a flaky local proxy more.
 */
export function transportRetries() {
    const raw = Number(process.env.GRAFLY_LLM_RETRIES ?? process.env.GRAFT_LLM_RETRIES);
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 4;
}
