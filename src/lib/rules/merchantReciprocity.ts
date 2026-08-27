// Merchant reciprocity — PACT V2 Milestone 4.
//
// Complements merchantTradeEvaluator.ts (Milestone 1's "is this deal
// worth it" quantity/price evaluator) with a second, independent
// question: "what did the buyer just do, and how should that change my
// willingness to move?" Deliberately NOT a mirror of
// buyerMoveSelector.ts — the buyer's HOLD/CONCEDE decision is about its
// OWN bargaining position; this is about the merchant's REACTION to the
// other side's behavior. Different question, different function.
//
// Scoped to PRICE reciprocity only this milestone (per the approved
// design) — the shape here (a single scalar comparison -> a named
// behavior -> a bounded multiplier + reason) is intentionally generic
// enough that a future milestone could add analogous
// evaluateBuyerQuantityReciprocity / evaluateBuyerDeliveryReciprocity
// functions alongside this one without restructuring anything, but
// those are NOT implemented here.

export type BuyerPriceBehavior = "CONCEDED" | "HELD" | "WITHDREW" | "UNKNOWN";

export interface MerchantReciprocity {
  behavior: BuyerPriceBehavior;
  /**
   * Multiplier applied on top of the existing stock-pressure speed
   * factor (resolveMerchantConcessionSpeedFactor, negotiationStrategy.ts)
   * inside computeMerchantConcessionPrice. 1.0 is a complete no-op —
   * the exact behavior this codebase used before this milestone existed.
   */
  speedMultiplier: number;
  reason: string;
}

// Starting calibration (explicitly not treated as sacred constants —
// see the Milestone 4 design review). Chosen to stay modest relative to
// the existing stock-pressure speed factor's own range
// (0.7 low-stock / 1.0 medium / 1.3 high-stock, negotiationStrategy.ts):
// combined, the widest possible swing is roughly 0.7*0.60=0.42 to
// 1.3*1.15=1.495 — still a bounded, gradual adjustment, never a cliff,
// and the final [minPrice, listedPrice] clamp in
// computeMerchantConcessionPrice is completely unaffected by any of
// these values regardless of magnitude.
const CONCEDED_MULTIPLIER = 1.15;
const HELD_MULTIPLIER = 0.75;
const WITHDREW_MULTIPLIER = 0.6;
const UNKNOWN_MULTIPLIER = 1.0;

/**
 * Compares the buyer's current ask against its own prior-round ask and
 * decides how that should modulate the merchant's willingness to
 * concede this round.
 *
 * - CONCEDED (buyer's ask moved up, toward the merchant): the merchant
 *   rewards genuine movement with a somewhat faster concession than the
 *   stock-pressure baseline alone would give.
 * - HELD (buyer's ask unchanged): the merchant recognizes the buyer
 *   isn't moving and slows down — still makes some progress (this is
 *   NOT a hard freeze; a genuine repeated stall is still caught
 *   separately by walkAway.ts's arePositionsRepeated), but noticeably
 *   less generous than if the buyer had reciprocated.
 * - WITHDREW (buyer's ask moved down — a real, already-possible
 *   reaction; see buyerRules.computeBuyerConcessionPrice's own comment
 *   about re-anchoring on the merchant's live offer): treated as the
 *   strongest signal to hold back.
 * - UNKNOWN (no prior buyer ask exists yet — the merchant's very first
 *   real response): a complete no-op, so every existing caller that
 *   predates this milestone (single-shot callers, and the very first
 *   real exchange in every multi-round negotiation) behaves exactly as
 *   before.
 *
 * Pure and synchronous. Never decides the actual price — only how
 * strongly computeMerchantConcessionPrice's existing formula should
 * lean this round; the hard [minPrice, listedPrice] clamp there is
 * completely unaffected by anything computed here.
 */
export function evaluateBuyerReciprocity(
  currentBuyerUnitPrice: number,
  priorBuyerUnitPrice: number | null | undefined,
): MerchantReciprocity {
  if (priorBuyerUnitPrice === null || priorBuyerUnitPrice === undefined) {
    return {
      behavior: "UNKNOWN",
      speedMultiplier: UNKNOWN_MULTIPLIER,
      reason: "",
    };
  }

  if (currentBuyerUnitPrice > priorBuyerUnitPrice) {
    return {
      behavior: "CONCEDED",
      speedMultiplier: CONCEDED_MULTIPLIER,
      reason: "The buyer moved toward the merchant's position, so the merchant reciprocates with a stronger concession.",
    };
  }

  if (currentBuyerUnitPrice === priorBuyerUnitPrice) {
    return {
      behavior: "HELD",
      speedMultiplier: HELD_MULTIPLIER,
      reason: "The buyer's price hasn't moved since its last offer, so the merchant is less willing to concede further.",
    };
  }

  return {
    behavior: "WITHDREW",
    speedMultiplier: WITHDREW_MULTIPLIER,
    reason: "The buyer's offer moved away from the merchant's position, so the merchant is holding back further concessions.",
  };
}
