// The Merchant Agent — Phase 4, refactored in Phase 5A to go through the
// provider-agnostic LLM boundary instead of importing Claude directly.
//
// Wraps the Phase 3 deterministic negotiation engine with an LLM-phrased
// explanation. The engine's NegotiationResult is the sole source of
// truth for every number in the response; the LLM is only ever asked to
// turn that already-decided result into a sentence. It cannot change
// `decision` or `offer` — both are built directly from the engine's
// output before the LLM is even called.

import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import {
  computeMerchantConcessionPrice,
  evaluateNegotiationRequest,
  type MerchantConcessionContext,
  type NegotiationRequest,
  type NegotiationResult,
} from "@/lib/rules/negotiationEngine";
import {
  explainMerchantFactors,
  hasQuantityLeverage,
  resolveDeliveryTrade,
} from "@/lib/rules/negotiationStrategy";
import { checkAgentMessageIntegrity } from "@/lib/agents/messageIntegrity";
import { getLlmProvider, LlmUnavailableError } from "@/lib/llm/provider";

export interface MerchantAgentOffer {
  sku: string;
  quantity: number;
  unitPrice: number;
  deliveryDays: number;
}

export interface MerchantAgentResponse {
  /** The authoritative deterministic result. The LLM never sees or touches this directly. */
  decision: NegotiationResult;
  /** Convenience view of the offer terms, or null when there's nothing to offer (REJECTED). */
  offer: MerchantAgentOffer | null;
  /** LLM-generated natural-language explanation of `decision`. */
  message: string;
}

const MERCHANT_SYSTEM_PROMPT = `You are PACT's Merchant Agent, communicating with an AI buyer agent on behalf of the merchant.

You will be given the AUTHORITATIVE result of a deterministic negotiation engine, as JSON. That engine has already decided everything commercial — whether the request can be fulfilled, the quantity, the unit price, and the delivery time. You were not given the merchant's private pricing rules and must not guess at them; you only know what is in the JSON.

Your only job is to phrase that result as a short, professional message to the buyer. Rules:
- Speak in first person as the merchant (e.g. "We can offer...", "We're unable to...").
- Be concise: 2-4 sentences, plain text only (no markdown, no JSON).
- State only the outcome, quantity, unit price, delivery days, and reasons EXACTLY as given in the JSON. Never invent, round, or otherwise change any number, product name, policy, or reason that isn't present in the JSON.
- Render every number exactly as given, in full — never truncate, abbreviate, or drop a digit (e.g. write 45375 in full, never 4537 or 45). Whenever an outcome carries a quantity, unit price, and delivery days, state all three.
- Do not claim a deal is agreed or final unless the outcome is "EXACT_MATCH" — for "COUNTER_OFFER" or "PARTIAL_FULFILLMENT", present the terms as an offer awaiting the buyer's response, not a completed deal.
- For "REJECTED", briefly explain why using only the given reasons, and do not propose alternative terms of your own.
- Never offer to negotiate further or suggest numbers beyond what was given to you.`;

/**
 * Strips a NegotiationResult down to exactly the fields the LLM is
 * allowed to see. NegotiationResult itself never carries minPrice or
 * any other private catalog field (see negotiationEngine.ts), so this
 * is a safe 1:1 field mapping rather than a filter that could miss
 * something — there is nothing private left to accidentally forward.
 */
function toPublicContext(result: NegotiationResult): Record<string, unknown> {
  return {
    // The block the LLM must treat as immutable fact — every number
    // here is what checkAgentMessageIntegrity (messageIntegrity.ts)
    // requires the final message to state verbatim.
    authoritativeFacts: {
      side: "MERCHANT" as const,
      action: result.outcome,
      sku: result.sku,
      requestedQuantity: result.requestedQuantity,
      quantity: result.offeredQuantity,
      unitPrice: result.unitPrice,
      deliveryDays: result.deliveryDays,
      reasons: result.reasons,
    },
    outcome: result.outcome,
    sku: result.sku,
    requestedQuantity: result.requestedQuantity,
    offeredQuantity: result.offeredQuantity,
    unitPrice: result.unitPrice,
    deliveryDays: result.deliveryDays,
    reasons: result.reasons,
  };
}

/**
 * Overrides a fresh NegotiationResult's price (and, when a delivery
 * trade applies, its delivery days) with the round-aware concession
 * strategy (computeMerchantConcessionPrice), when a round context is
 * supplied and a genuine price negotiation is actually in play. This is
 * what stops the merchant from treating "the buyer's ask is at or above
 * minPrice" as a reason to accept outright — minPrice is a floor, not a
 * target, so evaluateNegotiationRequest's single-shot "meet in the
 * middle once" price is replaced with a position that still tries to
 * hold closer to the listed price, conceding only gradually across
 * rounds, and now also folds in stock-pressure, quantity-leverage, and
 * delivery-for-price strategic factors (negotiationStrategy.ts).
 *
 * A no-op (returns `decision` unchanged) whenever there's nothing to
 * override: no round context supplied (preserves every existing
 * single-shot caller's exact behavior), the buyer's ceiling already
 * meets or beats the listed price (no negotiation needed at all), or
 * the outcome isn't one that carries a negotiated price in the first
 * place (REJECTED / no price adjustment needed).
 */
function applyMerchantConcession(
  item: CatalogItemSnapshot,
  request: NegotiationRequest,
  decision: NegotiationResult,
  concessionContext: MerchantConcessionContext,
): NegotiationResult {
  if (
    request.maxUnitPrice === undefined ||
    request.maxUnitPrice >= item.listedPrice ||
    decision.unitPrice === null ||
    (decision.outcome !== "COUNTER_OFFER" && decision.outcome !== "PARTIAL_FULFILLMENT")
  ) {
    return decision;
  }

  const trade =
    request.deliveryDeadlineDays !== undefined
      ? resolveDeliveryTrade(item, request.deliveryDeadlineDays, request.deliveryFlexible ?? false)
      : { deliveryDays: item.standardDeliveryDays, discount: 0, traded: false };

  const quantityLeveraged = hasQuantityLeverage(request.quantity);

  const concededPrice = computeMerchantConcessionPrice(item, request.maxUnitPrice, {
    ...concessionContext,
    requestedQuantity: request.quantity,
    deliveryTradeDiscount: trade.discount,
  });

  if (concededPrice === decision.unitPrice && trade.deliveryDays === decision.deliveryDays) {
    return decision;
  }

  const reasons = decision.reasons
    .filter((reason) => !reason.startsWith("Countering with an adjusted unit price"))
    .concat(
      `Countering with an adjusted unit price of ${concededPrice} instead of the listed ${item.listedPrice}.`,
      ...explainMerchantFactors(item, quantityLeveraged, trade),
    );

  return { ...decision, unitPrice: concededPrice, deliveryDays: trade.deliveryDays, reasons };
}

/**
 * Deterministic, non-LLM caption used only when no LLM provider is
 * configured (LlmUnavailableError) — e.g. running the demo UI without
 * ANTHROPIC_API_KEY set. Built entirely from the already-decided
 * `decision`, so it never fabricates a price, quantity, delivery day,
 * or outcome; it's a plain-English rendering of real data instead of
 * LLM prose.
 */
function buildFallbackMerchantMessage(decision: NegotiationResult): string {
  if (decision.outcome === "REJECTED") {
    return `We are unable to fulfill this request. ${decision.reasons.join(" ")}`.trim();
  }

  const parts = [
    `We can offer ${decision.offeredQuantity} unit(s)`,
    decision.requestedQuantity !== decision.offeredQuantity
      ? `(of the ${decision.requestedQuantity} requested)`
      : null,
    `at ${decision.unitPrice} per unit, delivered in ${decision.deliveryDays} day(s).`,
  ].filter(Boolean);

  return parts.join(" ");
}

function toOffer(result: NegotiationResult): MerchantAgentOffer | null {
  if (
    result.offeredQuantity === null ||
    result.unitPrice === null ||
    result.deliveryDays === null
  ) {
    return null;
  }
  return {
    sku: result.sku,
    quantity: result.offeredQuantity,
    unitPrice: result.unitPrice,
    deliveryDays: result.deliveryDays,
  };
}

/**
 * Runs the Merchant Agent for one buyer request: evaluate with the
 * deterministic engine, then have the LLM phrase the result. `item` is
 * whatever the caller's catalog lookup returned — pass null for "SKU
 * not found" (see catalogRepository.findCatalogItemBySku), the engine
 * handles it the same way it does everywhere else in the codebase.
 *
 * `concessionContext` is optional and only meaningful for a multi-round
 * negotiation (see negotiation/orchestrator.ts) — when supplied, it
 * makes the merchant negotiate for the highest valid price it can
 * across rounds instead of settling for evaluateNegotiationRequest's
 * single-shot "meet in the middle once" price. Omitting it (every
 * existing single-shot caller, e.g. POST /api/negotiate) leaves
 * behavior exactly as it was before this option existed.
 */
export async function runMerchantAgent(
  item: CatalogItemSnapshot | null,
  request: NegotiationRequest,
  concessionContext?: MerchantConcessionContext,
): Promise<MerchantAgentResponse> {
  let decision = evaluateNegotiationRequest(item, request);
  if (item && concessionContext) {
    decision = applyMerchantConcession(item, request, decision, concessionContext);
  }

  const context = toPublicContext(decision);
  const requiredNumbers =
    decision.outcome === "REJECTED"
      ? []
      : [decision.offeredQuantity, decision.unitPrice, decision.deliveryDays];

  let message: string;
  try {
    const generated = await getLlmProvider().generateAgentMessage({
      systemPrompt: MERCHANT_SYSTEM_PROMPT,
      context,
      instruction:
        "Generate only the natural-language message explaining this already-decided negotiation result, from the merchant's perspective. Do not calculate, change, abbreviate, round, infer, or invent any numeric value — every number in authoritativeFacts must appear in your message rendered exactly as given (e.g. 100 must remain 100, never 10; 45375 must remain 45375, never 4537). The structured decision is authoritative.",
    });
    const check = checkAgentMessageIntegrity(generated, requiredNumbers, context);
    if (check.valid) {
      message = generated;
    } else {
      console.warn(`Merchant Agent LLM message failed integrity check, falling back: ${check.reason}`);
      message = buildFallbackMerchantMessage(decision);
    }
  } catch (error) {
    if (!(error instanceof LlmUnavailableError)) {
      throw error;
    }
    // No LLM provider is configured — fall back to a deterministic
    // caption instead of failing the whole negotiation turn. The
    // decision itself (every number and the outcome) is completely
    // unaffected; only the phrasing differs.
    message = buildFallbackMerchantMessage(decision);
  }

  return {
    decision,
    offer: toOffer(decision),
    message,
  };
}
