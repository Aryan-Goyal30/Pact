// Anthropic-backed LlmProvider implementation.
//
// This is the only file in the codebase that imports the Anthropic SDK.
// It has exactly one job: turn an already-decided structured context into
// a short natural-language message, per the LlmProvider contract in
// provider.ts. It never decides prices, quantities, or delivery — those
// are supplied by the caller (Buyer/Merchant Agent) and only ever read
// here, never computed. Tests mock the provider boundary (see
// merchantAgent.test.ts / buyerAgent.test.ts) so no test makes a real
// API call or spends credits — claude.test.ts is the one exception,
// and it only exercises the missing-API-key path, which throws before
// any network call.

import Anthropic from "@anthropic-ai/sdk";
import type { AgentMessageInput, LlmProvider } from "@/lib/llm/provider";
import { LlmUnavailableError } from "@/lib/llm/errors";

/**
 * Thrown when ANTHROPIC_API_KEY is not set. A dedicated error type so
 * callers (and the API route) can recognize this specific, expected
 * failure mode and respond with a clear message instead of letting the
 * SDK fail deeper in the call with a less obvious error. Extends the
 * provider-agnostic LlmUnavailableError so agent code can catch the
 * general case without depending on this Claude-specific class.
 */
export class MissingApiKeyError extends LlmUnavailableError {
  constructor() {
    super(
      "ANTHROPIC_API_KEY is not set. Add it to your .env (see .env.example) to enable agent responses.",
    );
    this.name = "MissingApiKeyError";
  }
}

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new MissingApiKeyError();
  }
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return cachedClient;
}

export class ClaudeProvider implements LlmProvider {
  async generateAgentMessage(input: AgentMessageInput): Promise<string> {
    const client = getClient();

    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 300,
      output_config: { effort: "low" },
      system: input.systemPrompt,
      messages: [
        {
          role: "user",
          content: `${input.instruction}\n\nContext (authoritative — do not alter any value):\n${JSON.stringify(input.context, null, 2)}`,
        },
      ],
    });

    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text",
    );

    if (!textBlock || textBlock.text.trim().length === 0) {
      throw new Error("Claude response contained no text content.");
    }

    return textBlock.text.trim();
  }
}

export const claudeProvider: LlmProvider = new ClaudeProvider();
