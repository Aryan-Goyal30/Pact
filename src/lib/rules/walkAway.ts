// Deadlock / walk-away detection — PACT V2 Milestone 2.
//
// Pure, synchronous, same discipline as negotiationStrategy.ts and
// merchantTradeEvaluator.ts. This module answers exactly one question:
// "should this negotiation close as a legitimate walk-away instead of
// continuing?" — it never decides price/quantity/delivery itself, and
// it never decides HOW the walk-away is phrased (that's
// buyerAgent.ts/merchantAgent.ts's runBuyerWalkAway/runMerchantWalkAway,
// still going through the same LLM -> integrity -> fallback pipeline as
// every other message in this codebase).
//
// Two independent triggers, deliberately kept simple (no formulas, no
// tunable thresholds beyond "one repeated round"):
//
//  1. Structural impossibility: the buyer's ceiling is below the
//     merchant's floor, so no amount of further negotiation could ever
//     close the gap. Knowable immediately from item + buyerConstraints
//     alone — no history needed.
//  2. Repeated positions: both sides' current position is identical to
//     their own previous position. A one-round stall is enough — this
//     codebase's round-aware concession formulas are only ever flat
//     when there is genuinely nothing left to concede.

import { resolveEffectiveBudgetCeiling } from "@/lib/rules/buyerRules";

export type WalkAwayReason = "price_gap_unbridgeable" | "repeated_positions";

/**
 * True when the buyer's effective ceiling is below the merchant's
 * private floor on a negotiable item — no combination of rounds,
 * trades, or concessions can ever produce a mutually acceptable price.
 * Gated on `negotiationEnabled` so this never interferes with the
 * existing, already-correct REJECTED path a non-negotiable item's price
 * mismatch already takes (evaluateNegotiationRequest / resolvePrice) —
 * that path is untouched by this module.
 *
 * Pass 4 (budgetFlexible): for a hard budget, "effective ceiling" is
 * exactly `maxUnitPrice` — byte-identical to before this pass existed.
 * For a flexible budget, it's the SAME centralized safety cap
 * buyerRules.ts's concession logic uses (resolveEffectiveBudgetCeiling)
 * — a flexible buyer whose stated number is below floor does NOT
 * structurally walk away merely because of that stated number, but
 * still walks away once even the bounded safety cap can't reach the
 * floor. `item.listedPrice` is optional here only so existing test
 * fixtures that construct a minimal `item` without it keep compiling;
 * every real caller (orchestrator.ts) always has a real listedPrice.
 */
export function isPriceGapUnbridgeable(
  item: { minPrice: number; negotiationEnabled: boolean; listedPrice?: number },
  buyerConstraints: { maxUnitPrice: number; budgetFlexible?: boolean },
): boolean {
  const effectiveCeiling = resolveEffectiveBudgetCeiling(buyerConstraints, item.listedPrice);
  return item.negotiationEnabled && effectiveCeiling < item.minPrice;
}

/**
 * True when this round's buyer and merchant unit prices are both
 * identical to their own previous round's — i.e. neither side moved at
 * all. A single repeated round is treated as sufficient evidence of a
 * genuine stall (not a coincidence): the round-aware concession
 * formulas (computeBuyerConcessionPrice / computeMerchantConcessionPrice)
 * only ever produce the exact same number twice in a row when they are
 * already pinned at a hard clamp with nothing left to give.
 *
 * `previous*` being null/undefined (no prior round exists yet, e.g. the
 * opening round) always returns false — there is nothing to compare against.
 */
export function arePositionsRepeated(
  thisRound: { buyerUnitPrice: number | null; merchantUnitPrice: number | null },
  previousRound: { buyerUnitPrice: number | null | undefined; merchantUnitPrice: number | null | undefined },
): boolean {
  if (
    thisRound.buyerUnitPrice === null ||
    thisRound.merchantUnitPrice === null ||
    previousRound.buyerUnitPrice === null ||
    previousRound.buyerUnitPrice === undefined ||
    previousRound.merchantUnitPrice === null ||
    previousRound.merchantUnitPrice === undefined
  ) {
    return false;
  }

  return (
    thisRound.buyerUnitPrice === previousRound.buyerUnitPrice &&
    thisRound.merchantUnitPrice === previousRound.merchantUnitPrice
  );
}
