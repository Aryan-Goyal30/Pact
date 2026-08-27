// The Buyer Agent — Phase 5A, Part 3.
//
// Symmetric to merchantAgent.ts: a deterministic decision (what action
// to take — request / accept / reject / counter_offer, and with exactly
// which numbers) is made first by plain code, and the LLM is only ever
// asked to phrase that already-decided action as a message. The LLM
// never chooses the action or its numbers, and the system never parses
// its message back into structured data (see negotiation/protocol.ts).
//
// The Buyer Agent only ever sees: the buyer's own constraints, the
// merchant's public manifest listing for the SKU (PublicManifestProduct
// — exactly what GET /api/manifest would return), and the merchant's
// last NegotiationResult (which, like the manifest, never carries
// minPrice or any other private field — see negotiationEngine.ts).
// CatalogItemSnapshot is never imported here.
//
// Objective, mirrored against the merchant's: the buyer seeks the
// LOWEST acceptable price, the merchant seeks the HIGHEST valid price
// (see negotiationEngine.ts's computeMerchantConcessionPrice). The
// buyer enforces its side of that by never conceding upward past its
// own maxUnitPrice (isPriceAcceptable in buyerRules.ts is a hard
// ceiling, not a target) and by holding at that ceiling on every
// counter_offer rather than proposing something higher just to close
// faster — it only ever accepts a specific merchant offer once that
// offer's own price already satisfies the ceiling, never before.

import type { PublicManifestProduct } from "@/types/manifest";
import type { NegotiationResult, ProposedAgreement } from "@/lib/rules/negotiationEngine";
import {
  resolveBuyerTarget,
  validateMerchantProposal,
  type BuyerConcessionContext,
  type BuyerConstraints,
  type BuyerValidationResult,
} from "@/lib/rules/buyerRules";
import { explainBuyerFactors, hasQuantityLeverage } from "@/lib/rules/negotiationStrategy";
import { decideBuyerConcessionMove, type BuyerMove } from "@/lib/rules/buyerMoveSelector";
import type { WalkAwayReason } from "@/lib/rules/walkAway";
import { checkAgentMessageIntegrity } from "@/lib/agents/messageIntegrity";
import { getLlmProvider, LlmUnavailableError } from "@/lib/llm/provider";

export type BuyerAction =
  | ({ type: "request" } & ProposedAgreement)
  | ({ type: "counter_offer" } & ProposedAgreement)
  | ({ type: "accept" } & ProposedAgreement)
  | { type: "reject"; sku: string; quantity: null; unitPrice: null; deliveryDays: null };

export interface BuyerAgentResponse {
  action: BuyerAction;
  /** null only for the opening request, where there is no merchant offer yet to validate. */
  validation: BuyerValidationResult | null;
  message: string;
  /** Which strategic factors (urgency, quantity leverage, remaining rounds) shaped this action — see negotiationStrategy.explainBuyerFactors. Empty when none applied (e.g. an outright accept/reject, or no round context). */
  strategicReasons: string[];
}

/**
 * Optional Milestone 3 inputs for the buyer's HOLD-vs-CONCEDE decision
 * (buyerMoveSelector.ts). All optional and additive: a caller that omits
 * this entirely gets the exact pre-Milestone-3 behavior (always
 * concede) — see decideBuyerConcessionMove's own defaults.
 */
export interface BuyerStrategyContext {
  /** The merchant's unit price from one round before the offer being reacted to now — lets the buyer detect whether the merchant's most recent move was genuine progress. */
  priorMerchantUnitPrice?: number | null;
  /** The buyer's own previous-round unit price — the price HOLD repeats. */
  previousBuyerUnitPrice?: number | null;
  /** The buyer's live 0-100 leverage score (see leverage.ts), computed by the orchestrator from data buyerAgent.ts never itself has access to (item.minPrice) — only the aggregate public score crosses this boundary, the same one already sent to the browser. */
  leverageScore?: number;
}

const BUYER_SYSTEM_PROMPT = `You are PACT's Buyer Agent, communicating with a merchant's AI agent on behalf of the buyer.

You will be given the buyer's own requirement and an AUTHORITATIVE structured action that has already been decided by deterministic code — what to request, or whether to accept, reject, or counter the merchant's last offer, with exact numbers. You do not decide any of this yourself and must not propose different numbers.

Your only job is to phrase that action as a short, professional message to the merchant. Rules:
- Speak in first person as the buyer (e.g. "I need...", "I can accept...", "That's above my budget...").
- Be concise: 1-3 sentences, plain text only (no markdown, no JSON).
- State only the quantity, unit price, and delivery days EXACTLY as given — never invent, round, or change any number.
- Render every number exactly as given, in full — never truncate, abbreviate, or drop a digit (e.g. write 45375 in full, never 4537 or 45).
- Do not claim a deal is done unless the action type is "accept".
- Never mention a number, product, or constraint that wasn't given to you.`;

/**
 * Opens near the buyer's aspirational target rather than immediately
 * revealing its hard ceiling — only when a round context is supplied
 * AND the item actually supports negotiation. Without a round context
 * (e.g. an existing single-shot caller that predates this option), the
 * opening ask is the buyer's maxUnitPrice, exactly as before. On a
 * non-negotiable item there is nothing to gain by opening low — the
 * merchant only ever fulfills the exact listed price on those, so
 * lowballing would just get a real buyer wrongly rejected instead of
 * matched — so the buyer states its true ceiling there too.
 */
function buildOpeningRequest(
  constraints: BuyerConstraints,
  manifestProduct: PublicManifestProduct,
  concessionContext?: BuyerConcessionContext,
): BuyerAction {
  const aimForTarget = Boolean(concessionContext) && manifestProduct.negotiable;
  return {
    type: "request",
    sku: constraints.sku,
    quantity: constraints.quantity,
    unitPrice: aimForTarget ? resolveBuyerTarget(constraints) : constraints.maxUnitPrice,
    deliveryDays: constraints.deliveryDeadlineDays,
  };
}

function buildResponseToMerchantOffer(
  constraints: BuyerConstraints,
  merchantResult: NegotiationResult,
  concessionContext?: BuyerConcessionContext,
  strategyContext?: BuyerStrategyContext,
): {
  action: BuyerAction;
  validation: BuyerValidationResult;
  move: BuyerMove | null;
  moveReason: string | null;
} {
  if (
    merchantResult.outcome === "REJECTED" ||
    merchantResult.offeredQuantity === null ||
    merchantResult.unitPrice === null ||
    merchantResult.deliveryDays === null
  ) {
    return {
      action: { type: "reject", sku: constraints.sku, quantity: null, unitPrice: null, deliveryDays: null },
      validation: { outcome: "UNACCEPTABLE", reasons: merchantResult.reasons },
      move: null,
      moveReason: null,
    };
  }

  const proposal: ProposedAgreement = {
    sku: merchantResult.sku,
    quantity: merchantResult.offeredQuantity,
    unitPrice: merchantResult.unitPrice,
    deliveryDays: merchantResult.deliveryDays,
  };

  const validation = validateMerchantProposal(constraints, proposal);

  if (validation.outcome === "ACCEPTABLE") {
    return { action: { type: "accept", ...proposal }, validation, move: null, moveReason: null };
  }

  // Not acceptable yet. Adopt whatever quantity/delivery the merchant
  // already offered — no reason to keep re-asking for terms it has
  // already granted. The PRICE is where the buyer now genuinely
  // decides whether moving is worthwhile (buyerMoveSelector.ts) rather
  // than always conceding: HOLD repeats the buyer's own previous price,
  // CONCEDE uses the existing round-aware computeBuyerConcessionPrice
  // formula, completely unchanged. Without a round context (a caller
  // that predates this option), it holds flat at maxUnitPrice, exactly
  // as before Phase 5B even existed.
  if (!concessionContext) {
    return {
      action: {
        type: "counter_offer",
        sku: constraints.sku,
        quantity: proposal.quantity,
        unitPrice: constraints.maxUnitPrice,
        deliveryDays: proposal.deliveryDays,
      },
      validation,
      move: null,
      moveReason: null,
    };
  }

  const decision = decideBuyerConcessionMove(
    constraints,
    proposal.unitPrice,
    concessionContext,
    strategyContext?.priorMerchantUnitPrice,
    strategyContext?.previousBuyerUnitPrice,
    strategyContext?.leverageScore,
  );

  return {
    action: {
      type: "counter_offer",
      sku: constraints.sku,
      quantity: proposal.quantity,
      unitPrice: decision.unitPrice,
      deliveryDays: proposal.deliveryDays,
    },
    validation,
    move: decision.move,
    moveReason: decision.reason,
  };
}

/**
 * Deterministic, non-LLM caption used only when no LLM provider is
 * configured (LlmUnavailableError). Built entirely from the
 * already-decided `action`, so it never fabricates a number or a
 * decision — it's a plain-English rendering of real data.
 */
function buildFallbackBuyerMessage(action: BuyerAction): string {
  switch (action.type) {
    case "request":
      return `I would like ${action.quantity} unit(s) of ${action.sku}, at up to ${action.unitPrice} each, delivered within ${action.deliveryDays} day(s).`;
    case "counter_offer":
      return `I can go up to ${action.unitPrice} per unit for ${action.quantity} unit(s), delivered within ${action.deliveryDays} day(s).`;
    case "accept":
      return `I accept: ${action.quantity} unit(s) at ${action.unitPrice} each, delivered in ${action.deliveryDays} day(s).`;
    case "reject":
      return "I'm unable to proceed with this offer.";
  }
}

/**
 * Runs the Buyer Agent for one turn. `merchantResult` is null for the
 * buyer's opening move (no merchant response exists yet); otherwise the
 * buyer deterministically decides to accept/reject/counter by checking
 * it against its own constraints (buyerRules.ts) — the LLM only phrases
 * whichever action was decided.
 */
export async function runBuyerAgent(
  constraints: BuyerConstraints,
  manifestProduct: PublicManifestProduct,
  merchantResult: NegotiationResult | null,
  concessionContext?: BuyerConcessionContext,
  strategyContext?: BuyerStrategyContext,
): Promise<BuyerAgentResponse> {
  const { action, validation, moveReason } =
    merchantResult === null
      ? {
          action: buildOpeningRequest(constraints, manifestProduct, concessionContext),
          validation: null,
          moveReason: null,
        }
      : buildResponseToMerchantOffer(constraints, merchantResult, concessionContext, strategyContext);

  const roundsLeft = concessionContext
    ? Math.max(1, concessionContext.maxRounds - concessionContext.round + 1)
    : Number.POSITIVE_INFINITY;
  const strategicReasons =
    action.type === "request" || action.type === "counter_offer"
      ? [
          ...explainBuyerFactors(constraints.urgency, hasQuantityLeverage(constraints.quantity), roundsLeft),
          ...(moveReason ? [moveReason] : []),
        ]
      : [];

  // The block the LLM must treat as immutable fact — every number here
  // is what checkAgentMessageIntegrity requires the final message to
  // state verbatim (or, for numbers merely present elsewhere in the
  // wider context below, permits it to state).
  const authoritativeFacts = {
    side: "BUYER" as const,
    action: action.type,
    sku: action.sku,
    quantity: action.quantity,
    unitPrice: action.unitPrice,
    deliveryDays: action.deliveryDays,
    previousMerchantOfferUnitPrice: merchantResult?.unitPrice ?? null,
    strategicReasons,
  };
  const context = {
    authoritativeFacts,
    // targetUnitPrice is the buyer's OWN aspiration, not private
    // merchant data — safe to share, and helps the LLM phrase a
    // natural-sounding counter instead of a bare number.
    buyerConstraints: {
      sku: constraints.sku,
      quantity: constraints.quantity,
      maxUnitPrice: constraints.maxUnitPrice,
      targetUnitPrice: resolveBuyerTarget(constraints),
      deliveryDeadlineDays: constraints.deliveryDeadlineDays,
      buyerContext: constraints.buyerContext,
    },
    merchantListing: manifestProduct,
    action,
    validation,
  };

  const requiredNumbers =
    action.type === "reject" ? [] : [action.quantity, action.unitPrice, action.deliveryDays];

  let message: string;
  try {
    const generated = await getLlmProvider().generateAgentMessage({
      systemPrompt: BUYER_SYSTEM_PROMPT,
      context,
      instruction:
        "Generate only the natural-language message for this already-decided negotiation action, from the buyer's perspective. Do not calculate, change, abbreviate, round, infer, or invent any numeric value — every number in authoritativeFacts must appear in your message rendered exactly as given (e.g. 100 must remain 100, never 10; 45375 must remain 45375, never 4537). The structured decision is authoritative.",
    });
    const check = checkAgentMessageIntegrity(generated, requiredNumbers, context);
    if (check.valid) {
      message = generated;
    } else {
      console.warn(`Buyer Agent LLM message failed integrity check, falling back: ${check.reason}`);
      message = buildFallbackBuyerMessage(action);
    }
  } catch (error) {
    if (!(error instanceof LlmUnavailableError)) {
      throw error;
    }
    // No LLM provider is configured — fall back to a deterministic
    // caption instead of failing the whole negotiation turn. `action`
    // itself is completely unaffected; only the phrasing differs.
    message = buildFallbackBuyerMessage(action);
  }

  return { action, validation, message, strategicReasons };
}

/**
 * Deterministic, non-LLM walk-away caption — built entirely from real
 * numbers already known to the buyer (its own maxUnitPrice, and the
 * merchant's own last stated offer, which is public), so it never
 * fabricates a number or a reason.
 */
function buildFallbackBuyerWalkAwayMessage(
  reason: WalkAwayReason,
  maxUnitPrice: number,
  merchantOfferUnitPrice: number,
): string {
  if (reason === "repeated_positions") {
    return `We don't appear to be converging — my maximum remains ${maxUnitPrice} per unit, below your ${merchantOfferUnitPrice}, so I have to end this negotiation here.`;
  }
  return `${merchantOfferUnitPrice} per unit is above my maximum budget of ${maxUnitPrice}, so I can't proceed.`;
}

/**
 * Runs the Buyer Agent's walk-away decision: the deterministic layer
 * (walkAway.ts, consulted by the orchestrator) has already decided the
 * negotiation cannot succeed — this only phrases that decision. Carries
 * no quantity/delivery/price terms of its own (there is no offer on the
 * table to state), mirroring the existing "reject" action's shape.
 */
export async function runBuyerWalkAway(
  constraints: BuyerConstraints,
  merchantOfferUnitPrice: number,
  reason: WalkAwayReason,
): Promise<{ message: string }> {
  const authoritativeFacts = {
    side: "BUYER" as const,
    action: "walk_away",
    reason,
    ownMaxUnitPrice: constraints.maxUnitPrice,
    merchantOfferUnitPrice,
  };
  const context = { authoritativeFacts };

  let message: string;
  try {
    const generated = await getLlmProvider().generateAgentMessage({
      systemPrompt: BUYER_SYSTEM_PROMPT,
      context,
      instruction:
        "Generate only the natural-language message explaining that the buyer is walking away from this negotiation — the terms cannot be reconciled. Do not invent, change, or round any number. State clearly that the merchant's price (merchantOfferUnitPrice) exceeds the buyer's maximum budget (ownMaxUnitPrice). Do not propose new numbers or suggest the negotiation could still continue.",
    });
    const check = checkAgentMessageIntegrity(generated, [constraints.maxUnitPrice, merchantOfferUnitPrice], context);
    if (check.valid) {
      message = generated;
    } else {
      console.warn(`Buyer Agent walk-away message failed integrity check, falling back: ${check.reason}`);
      message = buildFallbackBuyerWalkAwayMessage(reason, constraints.maxUnitPrice, merchantOfferUnitPrice);
    }
  } catch (error) {
    if (!(error instanceof LlmUnavailableError)) {
      throw error;
    }
    message = buildFallbackBuyerWalkAwayMessage(reason, constraints.maxUnitPrice, merchantOfferUnitPrice);
  }

  return { message };
}
