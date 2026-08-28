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

  return candidates;
}

/**
 * The buyer's objective, as a named function rather than a bare
 * comparison buried in a sort() — lower is better. Starting point only
 * (per the Milestone 9 spec): price is the buyer's dominant existing
 * objective, and every candidate already computes one, so no new number
 * is invented. Deliberately easy to extend later (quantity value,
 * delivery value, history) without changing this function's signature
 * or its callers.
 */
export function scoreBuyerCandidate(candidate: CandidateMove): number {
  return candidate.unitPrice;
}

/**
 * Selects the best candidate for the buyer — the one with the lowest
 * score (see scoreBuyerCandidate). `candidates` must be non-empty;
 * generateBuyerCandidates always guarantees at least the ordinary
 * candidate.
 */
export function selectBestBuyerCandidate(candidates: CandidateMove[]): CandidateMove {
  return candidates.reduce((best, candidate) =>
    scoreBuyerCandidate(candidate) < scoreBuyerCandidate(best) ? candidate : best,
  );
}
