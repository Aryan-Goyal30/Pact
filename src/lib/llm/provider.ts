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
 * Returns the LLM provider agents should use. Currently always Claude —
 * a single call site to change (or make env-configurable) when a second
 * provider is added, without touching Buyer Agent / Merchant Agent code.
 */
export function getLlmProvider(): LlmProvider {
  return claudeProvider;
}
