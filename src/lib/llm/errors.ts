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
