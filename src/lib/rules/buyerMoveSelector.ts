// Buyer conditional concession move selection — PACT V2 Milestone 3.
//
// Mirrors merchantTradeEvaluator.ts's role for the merchant — instead
// of unconditionally computing "how far should price move," the buyer
// now asks "is moving worthwhile right now, or should I hold?" before
// computing a number. Reuses computeBuyerConcessionPrice (buyerRules.ts)
// completely unchanged for the actual CONCEDE price — this module only
// decides WHETHER to concede this round, and (for HOLD) what price to
// repeat instead.
//
// Deliberately asymmetric from the merchant's evaluator, not a mirrored
// formula: the buyer's decision is driven by whether the MERCHANT has
// moved and by the buyer's own bargaining leverage, never by
// inventory/order-value reasoning — that has no meaning on the buyer's
// side. The merchant asks "is this deal worth it"; the buyer asks "is
// there any reason to move again right now."

import {
  computeBuyerConcessionPrice,
  resolveBuyerTarget,
  type BuyerConcessionContext,
  type BuyerConstraints,
} from "@/lib/rules/buyerRules";

export type BuyerMove = "HOLD" | "CONCEDE";

export interface BuyerMoveDecision {
  move: BuyerMove;
  /** Always within [target, maxUnitPrice] — computeBuyerConcessionPrice's own clamp for CONCEDE; HOLD always repeats an already-clamped prior price. */
  unitPrice: number;
  reason: string;
}

/** Buyer leverage at/above this holds firm even if the merchant has technically moved a little — it can afford the patience. */
const HOLD_LEVERAGE_THRESHOLD = 60;
/** Buyer leverage at/below this concedes even if the merchant hasn't moved — protecting the deal actually closing matters more than testing firmness. */
const CONCEDE_LEVERAGE_THRESHOLD = 40;

/**
 * Decides whether the buyer should CONCEDE (move price toward the
 * merchant, via the existing round-aware formula, completely unchanged)
 * or HOLD (repeat its own previous price) this round.
 *
 * The final-2-rounds behavior is deliberately untouched and always wins:
 * regardless of merchant movement or leverage, the buyer still concedes
 * all the way to its true ceiling once only 2 rounds remain — this is
 * the guaranteed-convergence property the walk-away milestone's
 * correctness relies on, and HOLD is never available there.
 *
 * Outside the final rounds: holds when the merchant's last offer didn't
 * improve since its own prior offer (nothing new to react to — testing
 * whether the merchant is actually willing to move), OR when the
 * buyer's leverage is strong enough to afford patience regardless.
 * Concedes when the merchant did move, unless leverage is weak enough
 * that protecting the deal matters more than holding firm.
 */
export function decideBuyerConcessionMove(
  constraints: BuyerConstraints,
  merchantOfferUnitPrice: number,
  concessionContext: BuyerConcessionContext,
  priorMerchantUnitPrice: number | null | undefined,
  previousBuyerUnitPrice: number | null | undefined,
  buyerLeverageScore: number | undefined,
): BuyerMoveDecision {
  const roundsLeft = Math.max(1, concessionContext.maxRounds - concessionContext.round + 1);

  if (roundsLeft <= 2) {
    return {
      move: "CONCEDE",
      unitPrice: constraints.maxUnitPrice,
      reason: "Few negotiation rounds remain, so moving to the true ceiling rather than risk losing the deal.",
    };
  }

  const merchantMoved =
    priorMerchantUnitPrice === null || priorMerchantUnitPrice === undefined
      ? true // nothing to compare against yet (the buyer's first real counter) — behave exactly as before this milestone.
      : merchantOfferUnitPrice < priorMerchantUnitPrice;

  const stronglyLeveraged = buyerLeverageScore !== undefined && buyerLeverageScore >= HOLD_LEVERAGE_THRESHOLD;
  const weaklyLeveraged = buyerLeverageScore !== undefined && buyerLeverageScore <= CONCEDE_LEVERAGE_THRESHOLD;

  const shouldHold = (!merchantMoved || stronglyLeveraged) && !weaklyLeveraged;

  if (shouldHold) {
    const holdPrice =
      previousBuyerUnitPrice !== null && previousBuyerUnitPrice !== undefined
        ? previousBuyerUnitPrice
        : resolveBuyerTarget(constraints);
    return {
      move: "HOLD",
      unitPrice: holdPrice,
      reason: !merchantMoved
        ? "The merchant has not moved since its last offer, so holding position instead of conceding further."
        : "The buyer's bargaining position is strong enough to hold firm this round.",
    };
  }

  return {
    move: "CONCEDE",
    unitPrice: computeBuyerConcessionPrice(constraints, merchantOfferUnitPrice, concessionContext),
    reason: merchantMoved
      ? "The merchant moved, so the buyer reciprocates with its own concession."
      : "The buyer's bargaining position favors continuing to concede toward agreement.",
  };
}
