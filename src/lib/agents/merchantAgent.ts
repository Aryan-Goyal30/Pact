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
  evaluateNegotiationRequest,
  type MerchantConcessionContext,
  type NegotiationRequest,
  type NegotiationResult,
} from "@/lib/rules/negotiationEngine";
import { explainMerchantFactors, resolveDeliveryTrade } from "@/lib/rules/negotiationStrategy";
import { generateMerchantCandidates, selectBestMerchantCandidate } from "@/lib/rules/merchantMoveSelection";
import type { WalkAwayReason } from "@/lib/rules/walkAway";
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
 * rounds, and now also folds in stock-pressure and delivery-for-price
 * strategic factors (negotiationStrategy.ts).
 *
 * Quantity is handled differently from the other two factors: rather
 * than a flat discount applied whenever the order crosses the bulk
 * threshold, computeMerchantConcessionPrice is called WITHOUT
 * requestedQuantity to get a quantity-blind baseline, and
 * evaluateMerchantTrade (merchantTradeEvaluator.ts) decides — from the
 * merchant's own stock pressure, not a universal rule — whether and how
 * far that baseline should move for this order size. This is the "is
 * the deal worth it" question replacing "how far should price move."
 * computeMerchantConcessionPrice's own requestedQuantity branch is left
 * completely intact for any other caller; only this call site stops
 * using it.
 *
 * A no-op (returns `decision` unchanged) whenever there's nothing to
 * override: no round context supplied (preserves every existing
 * single-shot caller's exact behavior), the buyer's ceiling already
 * meets or beats the listed price (no negotiation needed at all), or
 * the outcome isn't one that carries a negotiated price in the first
 * place (REJECTED / no price adjustment needed).
 *
 * Milestone 4: `priorBuyerUnitPrice` (the buyer's own ask from one round
 * before the one being reacted to now) drives evaluateBuyerReciprocity
 * (merchantReciprocity.ts), which produces a speed multiplier folded
 * into the SAME baseline calculation the trade evaluator already
 * consumes — so a buyer concession/hold/withdrawal is reflected in the
 * baseline BEFORE evaluateMerchantTrade ever runs, without that
 * function (Milestone 1) needing to change at all. Omitted (undefined)
 * reproduces exactly today's behavior — see
 * evaluateBuyerReciprocity's UNKNOWN case.
 */
function applyMerchantConcession(
  item: CatalogItemSnapshot,
  request: NegotiationRequest,
  decision: NegotiationResult,
  concessionContext: MerchantConcessionContext,
  priorBuyerUnitPrice?: number | null,
  previousBuyerQuantity?: number | null,
  /**
   * Milestone 7: the buyer's own delivery-day ask from ONE ROUND BEFORE
   * `request` — lets the merchant recognize a genuine round-over-round
   * delivery EXTENSION (a delivery-for-price trade), mirroring
   * previousBuyerQuantity's Milestone 5 role exactly. Omitting it
   * reproduces exactly today's (pre-Milestone-7) behavior — only the
   * legacy, always-on resolveDeliveryTrade formula applies.
   */
  previousBuyerDeliveryDays?: number | null,
): NegotiationResult {
  if (
    request.maxUnitPrice === undefined ||
    request.maxUnitPrice >= item.listedPrice ||
    decision.unitPrice === null ||
    (decision.outcome !== "COUNTER_OFFER" && decision.outcome !== "PARTIAL_FULFILLMENT")
  ) {
    return decision;
  }

  // Milestone 9: generate every currently-eligible candidate (ordinary
  // concession, HOLD when the buyer isn't reciprocating, quantity trade,
  // delivery trade — see merchantMoveSelection.ts) and select whichever
  // is actually best for the merchant (highest price), instead of the
  // old hard-coded "quantity trade always takes priority over delivery"
  // rule. Every dimension's own evaluation logic (stock pressure,
  // reciprocity, floor clamping) is completely unchanged — only HOW the
  // winning move gets chosen is new.
  const { candidates, deliveryDays, reciprocityReason } = generateMerchantCandidates(
    item,
    request as NegotiationRequest & { maxUnitPrice: number },
    concessionContext,
    priorBuyerUnitPrice,
    previousBuyerQuantity,
    previousBuyerDeliveryDays,
  );
  const selected = selectBestMerchantCandidate(candidates);

  if (selected.unitPrice === decision.unitPrice && deliveryDays === decision.deliveryDays) {
    return decision;
  }

  const quantityIncreasedFromPrior =
    previousBuyerQuantity !== null &&
    previousBuyerQuantity !== undefined &&
    request.quantity > previousBuyerQuantity;
  const deliveryIncreasedFromPrior =
    previousBuyerDeliveryDays !== null &&
    previousBuyerDeliveryDays !== undefined &&
    request.deliveryDeadlineDays !== undefined &&
    request.deliveryDeadlineDays > previousBuyerDeliveryDays &&
    (request.deliveryFlexible ?? false);
  const trade =
    request.deliveryDeadlineDays !== undefined
      ? resolveDeliveryTrade(item, request.deliveryDeadlineDays, request.deliveryFlexible ?? false)
      : { deliveryDays: item.standardDeliveryDays, discount: 0, traded: false };

  const reasons = decision.reasons
    .filter((reason) => !reason.startsWith("Countering with an adjusted unit price"))
    .concat(
      `Countering with an adjusted unit price of ${selected.unitPrice} instead of the listed ${item.listedPrice}.`,
      ...(reciprocityReason ? [reciprocityReason] : []),
      // Only the reasoning behind the WINNING candidate is stated —
      // never a dimension the comparison considered but didn't select.
      ...(selected.move === "QUANTITY_FOR_PRICE" && quantityIncreasedFromPrior
        ? [
            `The buyer increased its requested quantity from ${previousBuyerQuantity} to ${request.quantity}, so the merchant evaluated the full package instead of price alone.`,
          ]
        : []),
      ...(selected.move === "DELIVERY_FOR_PRICE" && deliveryIncreasedFromPrior
        ? [
            `The buyer offered a longer delivery window (from ${previousBuyerDeliveryDays} to ${trade.deliveryDays} days) in exchange for a better price, so the merchant evaluated the full package instead of price alone.`,
          ]
        : []),
      selected.reason,
      // quantityLeveraged is false here — the winning candidate's own
      // reason above already supplies a more specific quantity/delivery
      // reason when relevant, so explainMerchantFactors only contributes
      // generic stock/delivery-trade reasons.
      ...explainMerchantFactors(item, false, trade),
    );

  return { ...decision, unitPrice: selected.unitPrice, deliveryDays, reasons };
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
 *
 * `priorBuyerUnitPrice` (Milestone 4) is likewise optional — the
 * buyer's own ask from one round before the one in `request`, used only
 * for reciprocity (merchantReciprocity.ts). Omitting it leaves the
 * merchant's concession exactly as strong as before this milestone.
 */
export async function runMerchantAgent(
  item: CatalogItemSnapshot | null,
  request: NegotiationRequest,
  concessionContext?: MerchantConcessionContext,
  priorBuyerUnitPrice?: number | null,
  /**
   * Milestone 5: the buyer's unit quantity from ONE ROUND BEFORE
   * `request` — lets the merchant recognize a genuine round-over-round
   * quantity increase (a quantity-for-price trade) even when the
   * absolute quantity stays below the flat bulk-order threshold. See
   * applyMerchantConcession. Omitting it reproduces exactly today's
   * behavior (only the absolute threshold can engage the trade evaluator).
   */
  previousBuyerQuantity?: number | null,
  /**
   * Milestone 7: the buyer's own delivery-day ask from ONE ROUND BEFORE
   * `request` — lets the merchant recognize a genuine round-over-round
   * delivery extension even when the legacy resolveDeliveryTrade formula
   * would already silently apply. See applyMerchantConcession.
   */
  previousBuyerDeliveryDays?: number | null,
): Promise<MerchantAgentResponse> {
  let decision = evaluateNegotiationRequest(item, request);
  if (item && concessionContext) {
    decision = applyMerchantConcession(
      item,
      request,
      decision,
      concessionContext,
      priorBuyerUnitPrice,
      previousBuyerQuantity,
      previousBuyerDeliveryDays,
    );
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

/**
 * Deterministic, non-LLM walk-away caption. Built entirely from the
 * buyer's own stated ask (public — the buyer said it) — never from
 * item.minPrice, which must never reach this message or its LLM
 * context, exactly like every other merchant-facing message in this
 * codebase.
 */
function buildFallbackMerchantWalkAwayMessage(reason: WalkAwayReason, buyerAskUnitPrice: number): string {
  if (reason === "repeated_positions") {
    return `We don't appear to be converging on terms, so we're unable to continue this negotiation at ${buyerAskUnitPrice} per unit.`;
  }
  return `We understand, but we're unable to meet ${buyerAskUnitPrice} per unit for this order while remaining viable.`;
}

/**
 * Runs the Merchant Agent's walk-away decision: the deterministic layer
 * (walkAway.ts, consulted by the orchestrator) has already decided the
 * negotiation cannot succeed — this only phrases that decision. Never
 * receives or reveals item.minPrice; the merchant's own private floor
 * stays exactly as invisible here as it is everywhere else in the
 * codebase — the message only ever explains that the buyer's own ask
 * cannot be met, not why.
 */
export async function runMerchantWalkAway(
  buyerAskUnitPrice: number,
  reason: WalkAwayReason,
): Promise<{ message: string }> {
  const authoritativeFacts = {
    side: "MERCHANT" as const,
    action: "walk_away",
    reason,
    buyerAskUnitPrice,
  };
  const context = { authoritativeFacts };

  let message: string;
  try {
    const generated = await getLlmProvider().generateAgentMessage({
      systemPrompt: MERCHANT_SYSTEM_PROMPT,
      context,
      instruction:
        "Generate only the natural-language message explaining that the merchant cannot proceed with this negotiation — the buyer's terms cannot be met. Do not invent, change, or round any number. State clearly that the buyer's requested price (buyerAskUnitPrice) cannot be met while fulfilling this order. Never mention or imply a specific minimum acceptable price of your own — only that the buyer's number does not work. Do not propose alternative numbers.",
    });
    const check = checkAgentMessageIntegrity(generated, [buyerAskUnitPrice], context);
    if (check.valid) {
      message = generated;
    } else {
      console.warn(`Merchant Agent walk-away message failed integrity check, falling back: ${check.reason}`);
      message = buildFallbackMerchantWalkAwayMessage(reason, buyerAskUnitPrice);
    }
  } catch (error) {
    if (!(error instanceof LlmUnavailableError)) {
      throw error;
    }
    message = buildFallbackMerchantWalkAwayMessage(reason, buyerAskUnitPrice);
  }

  return { message };
}
