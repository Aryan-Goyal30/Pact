// Google Gemini-backed LlmProvider implementation.
//
// Mirrors claude.ts's structure and contract exactly — this is the only
// file in the codebase that imports the Gemini SDK. It has exactly one
// job: turn an already-decided structured context into a short
// natural-language message, per the LlmProvider contract in
// provider.ts. It never decides prices, quantities, or delivery — those
// are supplied by the caller (Buyer/Merchant Agent) and only ever read
// here, never computed. Tests mock the provider boundary (see
// merchantAgent.test.ts / buyerAgent.test.ts) so no test makes a real
// API call or spends credits — gemini.test.ts is the one exception, and
// it only exercises the missing-API-key path, which throws before any
// network call.

import { GoogleGenAI } from "@google/genai";
import type { AgentMessageInput, LlmProvider } from "@/lib/llm/provider";
import { LlmUnavailableError } from "@/lib/llm/errors";

const GEMINI_MODEL = "gemini-3.6-flash";

/**
 * Thrown when GEMINI_API_KEY is not set. Extends the provider-agnostic
 * LlmUnavailableError so agent code can catch the general case without
 * depending on this Gemini-specific class — see claude.ts's
 * MissingApiKeyError for the same pattern on the Claude side.
 */
export class MissingGeminiApiKeyError extends LlmUnavailableError {
  constructor() {
    super(
      "GEMINI_API_KEY is not set. Add it to your .env (see .env.example) to enable agent responses via Gemini.",
    );
    this.name = "MissingGeminiApiKeyError";
  }
}

let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) {
    throw new MissingGeminiApiKeyError();
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return cachedClient;
}

export class GeminiProvider implements LlmProvider {
  async generateAgentMessage(input: AgentMessageInput): Promise<string> {
    const client = getClient();

    // The LlmProvider contract only ever returns a plain message string
    // — no structured data from the model feeds back into the system
    // (see provider.ts) — so there is nothing to gain from Gemini's
    // JSON/schema response mode here; plain text keeps this symmetric
    // with claude.ts and easy to validate (just "is it a non-empty
    // string"), with all structured negotiation values still decided
    // exclusively by the deterministic engine before this is ever
    // called.
    const response = await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: `${input.instruction}\n\nContext (authoritative — do not alter any value):\n${JSON.stringify(input.context, null, 2)}`,
      config: {
        systemInstruction: input.systemPrompt,
        maxOutputTokens: 300,
        temperature: 0.7,
      },
    });

    const text = response.text?.trim();
    if (!text) {
      throw new Error("Gemini response contained no text content.");
    }

    return text;
  }
}

export const geminiProvider: LlmProvider = new GeminiProvider();
