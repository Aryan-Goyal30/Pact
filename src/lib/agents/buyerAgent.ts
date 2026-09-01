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
import { HOLD_LEVERAGE_THRESHOLD, type BuyerMove } from "@/lib/rules/buyerMoveSelector";
import type { BuyerTradeMove } from "@/lib/rules/buyerQuantityTrade";
import type { BuyerDeliveryTradeMove } from "@/lib/rules/buyerDeliveryTrade";
import type { BuyerPackageTradeMove } from "@/lib/rules/buyerQuantityAndDeliveryTrade";
import { generateBuyerCandidates, selectBestBuyerCandidate } from "@/lib/rules/buyerMoveSelection";
import {
  evaluateQuantitySufficiency,
  type QuantitySufficiencyDecision,
} from "@/lib/rules/buyerQuantitySufficiency";
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
  /**
   * Milestone 3: HOLD or CONCEDE when the buyer's selected candidate this
   * round was the ordinary price move (buyerMoveSelector.ts) rather than
   * a trade — null whenever a trade candidate won instead (see
   * tradeMove), or when there was nothing to decide (opening request,
   * accept, reject, or no round context). Milestone 9: previously
   * computed internally but never returned from runMerchantAgent's
   * sibling here — now exposed alongside tradeMove so the full winning
   * candidate (HOLD / CONCEDE / QUANTITY_FOR_PRICE / DELIVERY_FOR_PRICE)
   * is always recoverable from the response without reconstructing it
   * from price/quantity/delivery diffs.
   */
  move: BuyerMove | null;
  /**
   * Milestone 5: whether this round's counter is a quantity-for-price
   * trade (buyerQuantityTrade.ts) rather than a plain price move. Null
   * whenever the trade decision was never consulted at all (the opening
   * request, an outright accept/reject, or a caller without a round
   * context) — distinct from "NO_TRADE", which means it WAS consulted
   * and declined. Internal/testability signal only — not yet threaded
   * into the public DTO (see the Milestone 5 design note). Milestone 7
   * widens this to also carry "DELIVERY_FOR_PRICE" — the two trade
   * dimensions are mutually exclusive within a round (see
   * buildResponseToMerchantOffer's waterfall), so this single field is
   * always enough to say which one (if either) fired. Milestone 9: the
   * mutual exclusivity is now a genuine comparison outcome (the
   * candidate with the better price wins), not merely "whichever rule
   * ran first."
   */
  tradeMove: BuyerTradeMove | BuyerDeliveryTradeMove | BuyerPackageTradeMove | null;
  /**
   * Milestone 6: the buyer's explicit, factor-based judgment of whether
   * the offered QUANTITY is actually sufficient — a separate question
   * from whether the offer is technically within hard constraints (see
   * buildResponseToMerchantOffer). Null whenever it was never consulted
   * (the offer wasn't hard-constraint-acceptable in the first place, the
   * opening request, an outright reject, or a caller without a round
   * context).
   */
  sufficiency: QuantitySufficiencyDecision | null;
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
  /**
   * Milestone 5: whether the buyer has already used its quantity-for-price
   * bargaining chip earlier in this same negotiation — derived by the
   * caller from actual negotiation history (see orchestrator.ts /
   * negotiationSessionRepository.ts), never guessed here. Omitted (or
   * false) means the chip is still available, exactly as if this option
   * didn't exist — every caller that predates Milestone 5 behaves
   * identically.
   */
  quantityTradeAlreadyUsed?: boolean;
  /**
   * Milestone 5: the buyer's own quantity from ONE ROUND BEFORE the
   * merchant offer being reacted to now. Used only to raise the
   * acceptance ceiling (validateMerchantProposal) when the merchant's
   * offer mirrors a quantity the buyer itself already asked for via a
   * trade — otherwise the buyer's own hard-coded original constraints.quantity
   * ceiling would wrongly reject its own larger request being fulfilled.
   * Omitted reproduces exactly today's ceiling (constraints.quantity).
   */
  previousBuyerQuantity?: number | null;
  /**
   * Milestone 7: whether the buyer has already used its delivery-for-price
   * bargaining chip earlier in this same negotiation — tracked entirely
   * independently from quantityTradeAlreadyUsed (using either chip never
   * consumes the other). Derived by the caller from actual negotiation
   * history, same discipline as quantityTradeAlreadyUsed. Omitted (or
   * false) means the chip is still available.
   */
  deliveryTradeAlreadyUsed?: boolean;
  /**
   * Milestone 7: the buyer's own delivery-day ask from ONE ROUND BEFORE
   * the offer being reacted to now. Used only to raise the acceptance
   * ceiling (validateMerchantProposal) when the merchant's offer mirrors
   * a later date the buyer itself already asked for via a trade —
   * mirrors previousBuyerQuantity's own Milestone 5 role exactly, for
   * the delivery dimension. Omitted reproduces exactly today's ceiling
   * (constraints.deliveryDeadlineDays).
   */
  previousBuyerDeliveryDays?: number | null;
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
  /**
   * Public information only — the exact same maxDeliveryDays field
   * GET /api/manifest already returns (PublicManifestProduct), threaded
   * down to generateBuyerCandidates so the delivery/combined trades'
   * own raw extension math can never propose an ask past what the
   * merchant could ever actually grant. Never the full
   * CatalogItemSnapshot or any private field — see this file's own
   * header comment on that boundary, still intact.
   */
  maxDeliveryDays: number,
  concessionContext?: BuyerConcessionContext,
  strategyContext?: BuyerStrategyContext,
): {
  action: BuyerAction;
  validation: BuyerValidationResult;
  move: BuyerMove | null;
  moveReason: string | null;
  tradeMove: BuyerTradeMove | BuyerDeliveryTradeMove | BuyerPackageTradeMove | null;
  sufficiency: QuantitySufficiencyDecision | null;
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
      tradeMove: null,
      sufficiency: null,
    };
  }

  const proposal: ProposedAgreement = {
    sku: merchantResult.sku,
    quantity: merchantResult.offeredQuantity,
    unitPrice: merchantResult.unitPrice,
    deliveryDays: merchantResult.deliveryDays,
  };

  // Milestone 5: once the buyer has asked for more than its original
  // quantity (via a trade), the merchant's offer mirroring that larger
  // ask must not be rejected as "too much" by the buyer's own
  // constraints.quantity ceiling — see isQuantityAcceptable's doc comment.
  const maxAcceptableQuantity = Math.max(
    constraints.quantity,
    strategyContext?.previousBuyerQuantity ?? 0,
  );
  // Milestone 7: same fix, for delivery — once the buyer has offered a
  // LATER date than its original deadline (via a delivery trade), the
  // merchant's offer mirroring that later date must not be rejected as
  // "too slow" by the buyer's own constraints.deliveryDeadlineDays
  // ceiling — see isDeliveryAcceptable's doc comment.
  const maxAcceptableDeliveryDays = Math.max(
    constraints.deliveryDeadlineDays,
    strategyContext?.previousBuyerDeliveryDays ?? 0,
  );
  const validation = validateMerchantProposal(
    constraints,
    proposal,
    maxAcceptableQuantity,
    maxAcceptableDeliveryDays,
  );

  // Milestone 6: technically satisfying every hard constraint
  // (price/quantity-ceiling/delivery) is NOT the same as the quantity
  // actually being enough — see buyerQuantitySufficiency.ts. This is a
  // deliberately SEPARATE question from buyerQuantityTrade.ts below:
  // that module asks "should I offer MORE than I need for a better
  // price" (a proactive give); this asks "is what's on offer enough of
  // what I actually need" (a reactive judgment about a shortfall). A
  // single round is only ever one or the other, never both — sufficiency
  // is only ever evaluated on the hard-constraint-ACCEPTABLE path, and
  // the trade chip's own gate independently refuses to fire whenever the
  // merchant is already short-supplying the original request, so the two
  // paths cannot both engage in the same round.
  //
  // Only applies when a round context exists — a single-shot caller that
  // predates Phase 5B's whole round-aware system (e.g. POST /api/negotiate)
  // never had any notion of "insufficient, try again next round" to begin
  // with, so it keeps its exact pre-Milestone-6 behavior: acceptable
  // means accept.
  //
  // Within the final-two-round safety net, sufficiency never blocks
  // acceptance — this is the SAME guaranteed-convergence carve-out every
  // other strategic overlay in this codebase already respects (see
  // computeBuyerConcessionPrice / computeMerchantConcessionPrice /
  // decideBuyerConcessionMove). Without it, a severe, genuinely
  // unresolvable shortfall (the merchant's stock is what it is — no
  // amount of further negotiating rounds changes that) would strand the
  // negotiation in an unreachable "insufficient forever" state instead of
  // closing on the best achievable terms, exactly the failure mode this
  // safety net was built to prevent.
  let sufficiency: QuantitySufficiencyDecision | null = null;
  if (validation.outcome === "ACCEPTABLE" && concessionContext) {
    sufficiency = evaluateQuantitySufficiency(constraints, proposal.quantity, proposal.unitPrice);
    const roundsLeft = Math.max(1, concessionContext.maxRounds - concessionContext.round + 1);
    // Negotiation Engine V2 (D4): a sufficient/price-compensated quantity
    // no longer forces an immediate accept when the buyer's own leverage
    // clearly favors holding out for more (reusing
    // buyerMoveSelector.HOLD_LEVERAGE_THRESHOLD — the SAME bar the
    // ordinary HOLD/CONCEDE decision already uses, never a new,
    // independently-calibrated threshold). This only NARROWS the
    // existing early-return; it never widens it — the final-2-rounds
    // safety net below is completely unconditional, exactly as before,
    // so the guaranteed-convergence property is untouched. When this
    // additional check declines to auto-accept, control falls through
    // to the SAME existing candidate generation/comparison path
    // (HOLD/CONCEDE/trades) the "not yet acceptable" branch already
    // uses below — no new code path, just a narrower gate on this one.
    const buyerLeverageScore = strategyContext?.leverageScore;
    // The leverage-driven narrowing is deliberately single-shot: it can
    // only decline an otherwise-acceptable offer on the buyer's FIRST
    // reactive round (no previousBuyerUnitPrice yet — nothing has been
    // held out for yet). Without this, an extremely high-leverage buyer
    // (>= HOLD_LEVERAGE_THRESHOLD) has no mechanism to ever relent: the
    // merchant can genuinely hit its own floor and be forced to repeat
    // that same, already-best-possible price every round, while this gate
    // keeps refusing it round after round purely on leverage — producing
    // a false EXPIRED (arePositionsRepeated trips) even though a real,
    // mutually-acceptable deal was on the table the whole time. Limiting
    // the gate to "have I already had at least one chance to hold out"
    // preserves D4's intent (a strong-leverage buyer gets a genuine shot
    // at a better offer instead of reflexively taking the first
    // technically-acceptable one) while guaranteeing it can never itself
    // be the cause of a repeated-position deadlock — after one round of
    // holding out, sufficiency's original unconditional accept resumes.
    const isFirstReactiveRound =
      strategyContext?.previousBuyerUnitPrice === null || strategyContext?.previousBuyerUnitPrice === undefined;
    const stronglyFavorsHolding =
      isFirstReactiveRound &&
      buyerLeverageScore !== undefined &&
      buyerLeverageScore >= HOLD_LEVERAGE_THRESHOLD;
    if ((sufficiency.verdict !== "INSUFFICIENT" && !stronglyFavorsHolding) || roundsLeft <= 2) {
      // SUFFICIENT (no meaningful shortfall, or one within tolerance),
      // INSUFFICIENT_PRICE_COMPENSATES (a real shortfall, but the price
      // is good enough to justify accepting it anyway), or the
      // final-rounds safety net — all are a genuine "accept this,"
      // never a blind quantity-fits-under-the-ceiling shortcut.
      return { action: { type: "accept", ...proposal }, validation, move: null, moveReason: null, tradeMove: null, sufficiency };
    }
    // INSUFFICIENT (or sufficient but the buyer's own leverage clearly
    // favors holding out for more), with real negotiating room still
    // ahead — fall through to negotiate instead of accepting, exactly
    // like the "not yet acceptable" path below.
  } else if (validation.outcome === "ACCEPTABLE") {
    // No round context (a single-shot caller) — exact pre-Milestone-6 behavior.
    return { action: { type: "accept", ...proposal }, validation, move: null, moveReason: null, tradeMove: null, sufficiency: null };
  }

  // Not acceptable yet (or acceptable but insufficient — see above).
  // Adopt whatever quantity/delivery the merchant already offered — no
  // reason to keep re-asking for terms it has already granted. The
  // PRICE is where the buyer now genuinely decides whether moving is
  // worthwhile (buyerMoveSelector.ts) rather than always conceding:
  // HOLD repeats the buyer's own previous price, CONCEDE uses the
  // existing round-aware computeBuyerConcessionPrice formula, completely
  // unchanged. Without a round context (a caller that predates this
  // option), it holds flat at maxUnitPrice, exactly as before Phase 5B
  // even existed.
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
      tradeMove: null,
      sufficiency,
    };
  }

  // Milestone 9: instead of trying quantity, then delivery, then falling
  // back to ordinary HOLD/CONCEDE (a fixed, first-eligible-wins
  // waterfall that always favored quantity over delivery whenever both
  // happened to qualify), generate every currently-eligible candidate —
  // the ordinary HOLD/CONCEDE decision (buyerMoveSelector.ts, unchanged)
  // plus the quantity and delivery trade candidates (unchanged gates) —
  // and select whichever one is actually best for the buyer (lowest
  // price — see buyerMoveSelection.ts). Nothing here decides eligibility
  // or computes a price itself; this only compares what the existing,
  // unchanged decision functions already independently produced.
  const candidates = generateBuyerCandidates(
    constraints,
    proposal.unitPrice,
    proposal.quantity,
    concessionContext,
    strategyContext,
    maxDeliveryDays,
  );
  const selected = selectBestBuyerCandidate(candidates, constraints, proposal.quantity, proposal.deliveryDays);

  const isTradeMove =
    selected.move === "QUANTITY_FOR_PRICE" ||
    selected.move === "DELIVERY_FOR_PRICE" ||
    selected.move === "QUANTITY_AND_DELIVERY_FOR_PRICE";

  return {
    action: {
      type: "counter_offer",
      sku: constraints.sku,
      quantity: selected.quantity ?? proposal.quantity,
      unitPrice: selected.unitPrice,
      deliveryDays: selected.deliveryDays ?? proposal.deliveryDays,
    },
    validation,
    // move/tradeMove keep their exact pre-Milestone-9 meaning and shape
    // (see BuyerAgentResponse's doc comments) — only HOW they get
    // populated changed, from "whichever branch ran first" to "whichever
    // candidate the comparison actually selected."
    move: isTradeMove ? null : (selected.move as BuyerMove),
    moveReason:
      !isTradeMove && sufficiency ? `${sufficiency.reason} ${selected.reason}` : selected.reason,
    tradeMove: isTradeMove
      ? (selected.move as BuyerTradeMove | BuyerDeliveryTradeMove | BuyerPackageTradeMove)
      : "NO_TRADE",
    sufficiency,
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
  const { action, validation, move, moveReason, tradeMove, sufficiency } =
    merchantResult === null
      ? {
          action: buildOpeningRequest(constraints, manifestProduct, concessionContext),
          validation: null,
          move: null,
          moveReason: null,
          tradeMove: null,
          sufficiency: null,
        }
      : buildResponseToMerchantOffer(
          constraints,
          merchantResult,
          manifestProduct.maxDeliveryDays,
          concessionContext,
          strategyContext,
        );

  const roundsLeft = concessionContext
    ? Math.max(1, concessionContext.maxRounds - concessionContext.round + 1)
    : Number.POSITIVE_INFINITY;
  const strategicReasons =
    action.type === "request" || action.type === "counter_offer"
      ? [
          ...explainBuyerFactors(constraints.urgency, hasQuantityLeverage(constraints.quantity), roundsLeft),
          ...(moveReason ? [moveReason] : []),
        ]
      : // Milestone 6: an "accept" is explainable too when it followed a
        // real sufficiency judgment (a genuine shortfall the buyer
        // decided was acceptable) — never populated merely because
        // "quantity <= requested," only when there was an actual
        // shortfall to reason about (sufficiency.shortfallFraction > 0).
        action.type === "accept" && sufficiency && sufficiency.shortfallFraction > 0
        ? [sufficiency.reason]
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
        "Generate only the natural-language message for this already-decided negotiation action, from the buyer's perspective. Do not calculate, change, abbreviate, round, infer, or invent any numeric value — every number in authoritativeFacts must appear in your message rendered exactly as given (e.g. 100 must remain 100, never 10; 45375 must remain 45375, never 4537). The structured decision is authoritative. If strategicReasons describes the buyer offering more quantity in exchange for a better price, phrase the message so that condition is clear (e.g. \"I'll take 200 units if you can bring the price down to 43000 each.\"). If strategicReasons describes the buyer accepting a later delivery date in exchange for a better price, phrase that condition instead (e.g. \"I can accept 10-day delivery if you can do 43000 each.\"). If strategicReasons describes the buyer offering BOTH more quantity AND a later delivery date together in exchange for a better price, phrase it as one combined condition (e.g. \"I'll take 200 units and accept 12-day delivery if you can do 43000 each.\"), never as two separate sentences or unrelated changes — still using only the exact numbers given. If strategicReasons describes the buyer holding its position rather than conceding further, the message must communicate firmness, not openness to moving higher — e.g. \"I'll hold at 42750 for now.\" or \"I'm not able to move above 42750 unless the terms change.\" — and must NOT use language like \"I can go up to\" or \"I can increase to\", which implies the buyer is still willing to move.",
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

  return { action, validation, message, strategicReasons, move, tradeMove, sufficiency };
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
