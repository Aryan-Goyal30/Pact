// Provider-agnostic LLM boundary — Phase 5A.
//
// Buyer Agent and Merchant Agent depend only on this interface, never on
// the Anthropic SDK directly:
//
//   Buyer Agent / Merchant Agent -> LlmProvider -> provider implementation
//
// This is what lets the underlying provider (Claude today) be swapped
// later without touching agent code. Every provider implementation must
// treat `context` as opaque, already-decided data to phrase — never a
// place to derive new prices, quantities, or delivery terms.

import { claudeProvider } from "@/lib/llm/claude";
import { geminiProvider } from "@/lib/llm/gemini";
import { LlmUnavailableError } from "@/lib/llm/errors";

export { LlmUnavailableError };

export interface AgentMessageInput {
  /** Persona rules the model must follow (what it can/can't say, whose voice to speak in). */
  systemPrompt: string;
  /**
   * Already-decided, structured context to ground the message in.
   * Callers are responsible for stripping anything private (e.g.
   * merchant minPrice) before this point — see toPublicContext() in
   * merchantAgent.ts for the pattern.
   */
  context: Record<string, unknown>;
  /** What this specific message should accomplish, e.g. "Explain this negotiation outcome to the buyer." */
  instruction: string;
}

export interface LlmProvider {
  generateAgentMessage(input: AgentMessageInput): Promise<string>;
}

/**
 * Returns the LLM provider agents should use, selected by the
 * LLM_PROVIDER env var ("claude" | "gemini", case-insensitive; defaults
 * to "claude" when unset). This is the single call site Buyer Agent /
 * Merchant Agent code goes through — neither knows or cares which
 * concrete provider is selected.
 *
 * Selecting a provider here does not require its API key to be present:
 * if the key is missing, the provider's generateAgentMessage() call
 * throws LlmUnavailableError, which buyerAgent.ts/merchantAgent.ts
 * already catch to fall back to a deterministic message rather than
 * fail the negotiation. So the application runs fine with no key, one
 * key, or the other key, in any combination with LLM_PROVIDER.
 */
export function getLlmProvider(): LlmProvider {
  const selected = (process.env.LLM_PROVIDER ?? "claude").trim().toLowerCase();

  switch (selected) {
    case "gemini":
      return geminiProvider;
    case "claude":
      return claudeProvider;
    default:
      console.warn(
        `Unrecognized LLM_PROVIDER "${process.env.LLM_PROVIDER}" — falling back to claude.`,
      );
      return claudeProvider;
  }
}
