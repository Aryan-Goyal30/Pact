// Buyer strategic move selection — PACT V2 Milestone 9.
//
// Replaces the old first-eligible waterfall (quantity trade, then
// delivery trade, then ordinary concession) with a genuine
// generate-then-compare decision: every currently-eligible move is
// computed as a CandidateMove, and the buyer picks whichever one is
// actually best by its own objective — never whichever rule happened to
// run first. buyerQuantityTrade.ts, buyerDeliveryTrade.ts, and
// buyerMoveSelector.ts are all called completely UNCHANGED — this module
// is purely the new coordination layer that adapts their existing
// outputs into one comparable shape.
//
// The "ordinary" candidate (HOLD or CONCEDE) is generated as ONE
// combined candidate from decideBuyerConcessionMove, not two separately
// price-ranked ones. This is a deliberate design choice, not an
// oversight: HOLD always repeats a lower price than a fresh CONCEDE, so
// if both were unconditionally available and ranked purely on price,
// HOLD would trivially win every single round and the buyer would never
// move at all — exactly the degenerate outcome buyerMoveSelector.ts's
// own situational eligibility logic (merchant movement + leverage) was
// built to prevent. That logic is preserved completely intact by
// reusing its single combined decision as this milestone's "ordinary"
// candidate, and comparing THAT (whichever it turned out to be) against
// the trade candidates — which is exactly the comparison this milestone
// asks for ("is a trade better than my ordinary move"), not a
// re-litigation of the already-solved "should I hold or concede"
// question.

import type { BuyerConcessionContext, BuyerConstraints } from "@/lib/rules/buyerRules";
import { decideBuyerConcessionMove } from "@/lib/rules/buyerMoveSelector";
import { decideBuyerQuantityTrade } from "@/lib/rules/buyerQuantityTrade";
import { decideBuyerDeliveryTrade } from "@/lib/rules/buyerDeliveryTrade";
import { decideBuyerQuantityAndDeliveryTrade } from "@/lib/rules/buyerQuantityAndDeliveryTrade";
import { evaluateQuantitySufficiency } from "@/lib/rules/buyerQuantitySufficiency";
import type { CandidateMove } from "@/lib/rules/candidateMove";

/** The subset of BuyerStrategyContext (buyerAgent.ts) this module needs — kept as a local shape so this file doesn't import buyerAgent.ts (which imports this file). */
export interface BuyerCandidateStrategyContext {
  priorMerchantUnitPrice?: number | null;
  previousBuyerUnitPrice?: number | null;
  leverageScore?: number;
  quantityTradeAlreadyUsed?: boolean;
  deliveryTradeAlreadyUsed?: boolean;
}

/**
 * Generates every currently-eligible candidate move. Always returns at
 * least one candidate (the ordinary HOLD/CONCEDE decision, which
 * decideBuyerConcessionMove guarantees to always produce). The trade
 * candidates are only included when their own existing eligibility gate
 * (buyerQuantityTrade.ts / buyerDeliveryTrade.ts, both unchanged) says
 * yes — this function never second-guesses or overrides that gate,
 * only decides what happens once more than one candidate is eligible.
 *
 * Leverage is never used here to decide ELIGIBILITY — that would be the
 * exact Milestone 5 mistake this codebase already made and fixed once
 * (see the Milestone 6 browser-failure review). It only reaches this
 * function as an input the underlying decision functions already use to
 * size their own asks, exactly as before.
 */
export function generateBuyerCandidates(
  constraints: BuyerConstraints,
  merchantOfferUnitPrice: number,
  merchantOfferedQuantity: number,
  concessionContext: BuyerConcessionContext,
  strategyContext: BuyerCandidateStrategyContext | undefined,
): CandidateMove[] {
  const candidates: CandidateMove[] = [];

  const ordinary = decideBuyerConcessionMove(
    constraints,
    merchantOfferUnitPrice,
    concessionContext,
    strategyContext?.priorMerchantUnitPrice,
    strategyContext?.previousBuyerUnitPrice,
    strategyContext?.leverageScore,
  );
  candidates.push({
    move: ordinary.move,
    unitPrice: ordinary.unitPrice,
    reason: ordinary.reason,
  });

  const quantityDecision = decideBuyerQuantityTrade(
    constraints,
    merchantOfferUnitPrice,
    merchantOfferedQuantity,
    concessionContext,
    strategyContext?.priorMerchantUnitPrice,
    strategyContext?.leverageScore,
    strategyContext?.quantityTradeAlreadyUsed ?? false,
  );
  if (quantityDecision.move === "QUANTITY_FOR_PRICE") {
    candidates.push({
      move: "QUANTITY_FOR_PRICE",
      unitPrice: quantityDecision.unitPrice as number,
      quantity: quantityDecision.quantity as number,
      reason: quantityDecision.reason,
    });
  }

  const deliveryDecision = decideBuyerDeliveryTrade(
    constraints,
    merchantOfferUnitPrice,
    concessionContext,
    strategyContext?.leverageScore,
    strategyContext?.deliveryTradeAlreadyUsed ?? false,
  );
  if (deliveryDecision.move === "DELIVERY_FOR_PRICE") {
    candidates.push({
      move: "DELIVERY_FOR_PRICE",
      unitPrice: deliveryDecision.unitPrice as number,
      deliveryDays: deliveryDecision.deliveryDays as number,
      reason: deliveryDecision.reason,
    });
  }

  // Milestone 12: the combined quantity+delivery package — its own
  // eligibility gate (the intersection of the two solo trades' gates,
  // see buyerQuantityAndDeliveryTrade.ts) decides whether it's even
  // constructible this round; it is generated here as a THIRD,
  // independent candidate alongside the two solo trades and the ordinary
  // decision, never as a replacement for either, and never with any
  // priority over them — selectBestBuyerCandidate (unchanged) decides
  // whether it's actually the buyer's best move.
  const packageDecision = decideBuyerQuantityAndDeliveryTrade(
    constraints,
    merchantOfferUnitPrice,
    merchantOfferedQuantity,
    concessionContext,
    strategyContext?.leverageScore,
    strategyContext?.quantityTradeAlreadyUsed ?? false,
    strategyContext?.deliveryTradeAlreadyUsed ?? false,
  );
  if (packageDecision.move === "QUANTITY_AND_DELIVERY_FOR_PRICE") {
    candidates.push({
      move: "QUANTITY_AND_DELIVERY_FOR_PRICE",
      unitPrice: packageDecision.unitPrice as number,
      quantity: packageDecision.quantity as number,
      deliveryDays: packageDecision.deliveryDays as number,
      reason: packageDecision.reason,
    });
  }

  return candidates;
}

/**
 * The buyer's objective, as a named function rather than a bare
 * comparison buried in a sort() — lower is better. Introduced in
 * Milestone 9 as the starting point; RETAINED here, unused by
 * selectBestBuyerCandidate itself, purely so
 * buyerMoveSelection.oldVsNew.test.ts can reconstruct exactly
 * Milestone 9/10's price-only selection and prove Milestone 11's package
 * comparator (compareBuyerPackages, below) is behaviorally equivalent to
 * it across every candidate set this codebase can currently produce —
 * see that module's own doc comment for why this is a genuine, provable
 * no-op, not merely an empirically-observed coincidence.
 */
export function scoreBuyerCandidate(candidate: CandidateMove): number {
  return candidate.unitPrice;
}

/**
 * Milestone 11: package/deal-value comparison — PACT V2.
 *
 * A named LEXICOGRAPHIC comparison, not a weighted utility score. There
 * is deliberately no `priceWeight * price + quantityWeight * quantity +
 * ...` anywhere in this file: that would invent arbitrary weights the
 * current product requirements do not justify (see the Milestone 11
 * design review). Instead, three tiers are compared IN ORDER, each only
 * consulted when every earlier tier ties exactly:
 *
 *  1. Quantity sufficiency (evaluateQuantitySufficiency, reused
 *     verbatim, never duplicated) — a candidate whose resolved quantity
 *     would leave the buyer under-supplied ranks below one that doesn't,
 *     REGARDLESS of price. This is what stops a much-cheaper-but-short
 *     candidate from automatically winning just because price is the
 *     only thing being compared (the milestone's own Case C).
 *  2. Unit price — lower wins. Exactly today's (Milestone 9/10) rule,
 *     now only reached once sufficiency has already tied.
 *  3. Delivery days — ONLY on an exact price tie, faster (lower) wins.
 *     A real but secondary preference (the milestone's own Case B): it
 *     can break a tie, but it can never override tier 2 — a genuinely
 *     higher price is never forgiven by a better delivery date alone.
 *
 * A candidate's "resolved quantity"/"resolved delivery" for tiers 1/3
 * falls back to `currentQuantity`/`currentDeliveryDays` (the round's
 * existing terms) whenever the candidate itself doesn't set that field —
 * the same "absence means no change" convention CandidateMove's own
 * fields already use everywhere else in this codebase; never invented
 * here.
 *
 * Returns positive when `a` is the preferred package, negative when `b`
 * is, 0 on an exact tie across all three tiers (letting the caller's own
 * reduce() preserve its existing first-encountered tie-break — see
 * selectBestBuyerCandidate).
 */
export function compareBuyerPackages(
  a: CandidateMove,
  b: CandidateMove,
  constraints: BuyerConstraints,
  currentQuantity: number,
  currentDeliveryDays: number,
): number {
  const rankA = sufficiencyRank(a, constraints, currentQuantity);
  const rankB = sufficiencyRank(b, constraints, currentQuantity);
  if (rankA !== rankB) {
    return rankB - rankA; // a lower rank (more sufficient) is preferred
  }

  if (a.unitPrice !== b.unitPrice) {
    return b.unitPrice - a.unitPrice; // a lower price is preferred
  }

  const deliveryA = a.deliveryDays ?? currentDeliveryDays;
  const deliveryB = b.deliveryDays ?? currentDeliveryDays;
  return deliveryB - deliveryA; // a lower (faster) delivery is preferred
}

/**
 * Tier-1 helper for compareBuyerPackages: the sufficiency VERDICT a
 * candidate would produce if adopted, collapsed to a numeric rank (lower
 * = more sufficient = preferred). Deliberately keyed on the verdict
 * alone, not shortfallFraction — two candidates that both land on
 * SUFFICIENT (even at different shortfall sizes within tolerance) are
 * meant to tie at tier 1 and fall through to price, matching the
 * Milestone 11 spec's own "equal sufficiency falls through to price"
 * requirement.
 */
function sufficiencyRank(
  candidate: CandidateMove,
  constraints: BuyerConstraints,
  currentQuantity: number,
): 0 | 1 | 2 {
  const offeredQuantity = candidate.quantity ?? currentQuantity;
  const { verdict } = evaluateQuantitySufficiency(constraints, offeredQuantity, candidate.unitPrice);
  switch (verdict) {
    case "SUFFICIENT":
      return 0;
    case "INSUFFICIENT_PRICE_COMPENSATES":
      return 1;
    case "INSUFFICIENT":
      return 2;
  }
}

/**
 * Selects the best candidate for the buyer via compareBuyerPackages.
 * `candidates` must be non-empty; generateBuyerCandidates always
 * guarantees at least the ordinary candidate. `currentQuantity` /
 * `currentDeliveryDays` are the round's existing terms (the merchant's
 * current offer) — the fallback compareBuyerPackages uses for any
 * candidate that doesn't itself change that dimension.
 */
export function selectBestBuyerCandidate(
  candidates: CandidateMove[],
  constraints: BuyerConstraints,
  currentQuantity: number,
  currentDeliveryDays: number,
): CandidateMove {
  return candidates.reduce((best, candidate) =>
    compareBuyerPackages(candidate, best, constraints, currentQuantity, currentDeliveryDays) > 0
      ? candidate
      : best,
  );
}
