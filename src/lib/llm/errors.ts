// Split into its own file (no dependencies) to avoid a circular import
// between provider.ts (which needs the concrete claudeProvider value
// from claude.ts) and claude.ts (which needs this class). Both import
// it from here instead of from each other.

/**
 * Base class for "no LLM is currently usable" failures (e.g. missing
 * credentials). Provider implementations throw a subclass of this
 * (see claude.ts's MissingApiKeyError) instead of a plain Error, so
 * callers can recognize this specific, expected condition without
 * importing anything provider-specific — see buyerAgent.ts /
 * merchantAgent.ts, which catch this to fall back to a deterministic,
 * non-LLM message rather than fail the whole negotiation turn just
 * because no provider is configured yet.
 */
export class LlmUnavailableError extends Error {}

/**
 * Provider-failure handling: thrown when the underlying LLM provider
 * rejected the request with HTTP 429 (rate limit / quota exhausted —
 * e.g. Gemini's free-tier generate_content quota; 5 requests/minute was
 * the figure observed for the previously-used gemini-3.6-flash model —
 * see gemini.ts's GEMINI_MODEL for the model actually in use). Extends
 * LlmUnavailableError so buyerAgent.ts /
 * merchantAgent.ts already catch it via the SAME `instanceof
 * LlmUnavailableError` check used for "no API key configured" — a
 * transient rate limit is just another reason "no LLM is currently
 * usable" this turn, and falls back to the same deterministic message
 * (which already carries every authoritative number) rather than
 * failing the whole negotiation turn with a 500. Each provider
 * implementation (claude.ts / gemini.ts) is responsible for recognizing
 * its own SDK's 429 shape and throwing this instead of letting the raw
 * SDK error propagate — see either file's own try/catch around its
 * network call. `provider` lets a caller that wants to specifically
 * observe/log a rate limit (see either agent's own catch block, and the
 * /turn route's outer catch as a defense-in-depth backstop) distinguish
 * it from an ordinary missing-key condition without new plumbing.
 */
export class ProviderRateLimitedError extends LlmUnavailableError {
  readonly provider: string;

  constructor(provider: string) {
    super(
      `${provider} LLM provider rate-limited this request (HTTP 429) — falling back to a deterministic message.`,
    );
    this.name = "ProviderRateLimitedError";
    this.provider = provider;
  }
}
