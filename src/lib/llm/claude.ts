// Thin wrapper around the Anthropic SDK for the Merchant Agent persona.
//
// This module has exactly one job: turn an already-decided negotiation
// result into a short natural-language message. It never decides prices,
// quantities, or delivery — those come in as plain data from the caller
// (src/lib/agents/merchantAgent.ts) and are only ever read here, never
// computed. Tests mock this whole module (see merchantAgent.test.ts) so
// no test makes a real API call or spends credits.

import Anthropic from "@anthropic-ai/sdk";

/**
 * Thrown when ANTHROPIC_API_KEY is not set. A dedicated error type so
 * callers (and the API route) can recognize this specific, expected
 * failure mode and respond with a clear message instead of letting the
 * SDK fail deeper in the call with a less obvious error.
 */
export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY is not set. Add it to your .env (see .env.example) to enable Merchant Agent responses.",
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

const MERCHANT_SYSTEM_PROMPT = `You are PACT's Merchant Agent, communicating with an AI buyer agent on behalf of the merchant.

You will be given the AUTHORITATIVE result of a deterministic negotiation engine, as JSON. That engine has already decided everything commercial — whether the request can be fulfilled, the quantity, the unit price, and the delivery time. You were not given the merchant's private pricing rules and must not guess at them; you only know what is in the JSON.

Your only job is to phrase that result as a short, professional message to the buyer. Rules:
- Speak in first person as the merchant (e.g. "We can offer...", "We're unable to...").
- Be concise: 2-4 sentences, plain text only (no markdown, no JSON).
- State only the outcome, quantity, unit price, delivery days, and reasons EXACTLY as given in the JSON. Never invent, round, or otherwise change any number, product name, policy, or reason that isn't present in the JSON.
- Do not claim a deal is agreed or final unless the outcome is "EXACT_MATCH" — for "COUNTER_OFFER" or "PARTIAL_FULFILLMENT", present the terms as an offer awaiting the buyer's response, not a completed deal.
- For "REJECTED", briefly explain why using only the given reasons, and do not propose alternative terms of your own.
- Never offer to negotiate further or suggest numbers beyond what was given to you.`;

/** The public (never-private) subset of a negotiation result the LLM is allowed to see. */
export interface MerchantMessageContext {
  outcome: string;
  sku: string;
  requestedQuantity: number;
  offeredQuantity: number | null;
  unitPrice: number | null;
  deliveryDays: number | null;
  reasons: string[];
}

/**
 * Asks Claude to phrase a deterministic negotiation result as a short
 * merchant message. `context` must already be stripped of anything
 * merchant-private (minPrice, internal rule details, etc.) by the
 * caller — see toPublicContext in merchantAgent.ts.
 */
export async function generateMerchantMessage(
  context: MerchantMessageContext,
): Promise<string> {
  const client = getClient();

  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 300,
    output_config: { effort: "low" },
    system: MERCHANT_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Deterministic negotiation result (authoritative — do not alter any value):\n${JSON.stringify(context, null, 2)}\n\nWrite the merchant's message to the buyer.`,
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
