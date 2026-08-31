// Buyer quantity-for-price bargaining — PACT V2 Milestone 5.
//
// The first REAL conditional trade in this codebase: instead of only
// ever moving PRICE, the buyer can decide to offer MORE QUANTITY
// specifically in exchange for a better unit price. This is a genuine
// structured decision (mirrors buyerMoveSelector.ts's HOLD/CONCEDE
// shape) — not a case of quietly changing the quantity field and
// explaining it after the fact. The caller (buyerAgent.ts) only ever
// emits the quantity/price this function decided; it never independently
// picks a quantity and asks this module to justify it afterward.
//
// Deliberately NOT a mirror of merchantTradeEvaluator.ts: the merchant
// asks "is this deal worth it for my inventory/margin"; this asks "is
// this a good moment to use my one quantity chip" — driven by whether
// the merchant has stalled and by the buyer's own leverage (the same
// signals buyerMoveSelector.ts already uses for HOLD), never by
// inventory/margin reasoning, which has no meaning on the buyer's side.
//
// Scoped to quantity<->price only this milestone. The shape here (a
// small pure decision returning a named move + a package + a reason) is
// intentionally generic enough that a future delivery-for-price milestone
// could add an analogous decideBuyerDeliveryTrade alongside this one
// without restructuring anything — but that is NOT implemented here.

import {
  computeBuyerConcessionPrice,
  resolveBuyerTarget,
  type BuyerConcessionContext,
  type BuyerConstraints,
} from "@/lib/rules/buyerRules";
import {
  QUANTITY_TRADE_MIN_MEANINGFUL_PRICE_IMPROVEMENT_RATIO,
  resolveQuantityTradeIncreaseFraction,
  resolveQuantityTradePriceImprovementFraction,
} from "@/lib/rules/negotiationStrategy";

export type BuyerTradeMove = "NO_TRADE" | "QUANTITY_FOR_PRICE";

export interface BuyerQuantityTradeDecision {
  move: BuyerTradeMove;
  /** The proposed order quantity. Only meaningful when move is QUANTITY_FOR_PRICE; null for NO_TRADE. */
  quantity: number | null;
  /** The price asked for in exchange for that quantity. Null for NO_TRADE. Always within [target, maxUnitPrice] — never above the buyer's hard ceiling. */
  unitPrice: number | null;
  reason: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * How aggressively the buyer's price ask scales with its own leverage —
 * PACT V2 Milestone 6. Deliberately continuous, not a threshold band:
 * leverage shapes HOW MUCH to ask for, never WHETHER the buyer is
 * allowed to consider the bargaining dimension at all (see the
 * Milestone 6 design review — a leverage BAND gate was found to
 * incorrectly block a high-leverage buyer from a genuinely useful trade
 * opportunity in real browser testing). Centered at leverageScore 50 ->
 * 1.0 (today's plain discount, unchanged); a strong buyer (100) asks for
 * up to 1.5x the ordinary discount; a weak buyer (0) still tries, but
 * only asks for 0.5x — a real, reachable, non-zero ask either way.
 *
 * Exported so buyerDeliveryTrade.ts (Milestone 7) can reuse the exact
 * same leverage-sizing curve for its own price ask, rather than
 * duplicating it — this is generic to "how hard should the buyer push,"
 * not specific to quantity at all.
 */
export function resolveLeverageAskMultiplier(buyerLeverageScore: number): number {
  return clamp(0.5 + buyerLeverageScore / 100, 0.5, 1.5);
}

/**
 * Decides whether the buyer should use its (single-use, per-negotiation)
 * quantity-for-price bargaining chip this round.
 *
 * ELIGIBILITY (whether the trade is considered at all) is driven purely
 * by the concrete situation on the table this round — never by leverage:
 * rounds remain beyond the final-two-round safety net (the same
 * guarantee every other strategic overlay in this codebase respects); a
 * real price gap still exists (no point trading for a price already at
 * the buyer's own target); the merchant is not already short-supplying
 * the buyer's ORIGINAL request (offering more when stock is already
 * constrained is self-defeating, and would collide with the existing
 * partial-fulfillment path); and the chip has not already been used
 * earlier in this same negotiation (quantityTradeAlreadyUsed — computed
 * by the caller from actual negotiation history, see orchestrator.ts /
 * negotiationSessionRepository.ts).
 *
 * Milestone 6 correction: leverage previously gated ELIGIBILITY itself
 * (only a "moderate" band between CONCEDE_LEVERAGE_THRESHOLD and
 * HOLD_LEVERAGE_THRESHOLD could ever trade) — real browser testing
 * showed this incorrectly excluded a genuinely strong-leverage buyer
 * from a real opportunity (a high-leverage buyer facing real headroom
 * and an unused chip has every reason to still ask for more, and is in
 * fact best positioned to get it). Leverage now only modulates the SIZE
 * of the ask (resolveLeverageAskMultiplier) once eligibility is already
 * established by the situational checks above — mirroring
 * merchantReciprocity.ts's continuous-multiplier shape rather than
 * buyerMoveSelector.ts's binary HOLD/CONCEDE bands.
 *
 * `buyerLeverageScore` being undefined is still treated as ineligible
 * (not as a neutral default multiplier) — this is a narrower,
 * intentionally-preserved technical gate: it is what keeps every
 * existing caller that never computed a leverage score (most direct
 * buyerAgent.ts/buyerMoveSelector.ts unit tests, and any single-shot
 * caller that predates leverage.ts entirely) completely unaffected,
 * falling straight through to decideBuyerConcessionMove exactly as
 * before. This is unrelated to the eligibility-band question above —
 * it's "did the caller opt into the leverage-aware pathway at all," not
 * a strategic judgment about the buyer's position.
 *
 * This also does NOT require "the merchant hasn't moved" (the signal
 * buyerMoveSelector.ts's HOLD uses). Empirically, this codebase's
 * round-aware concession formulas concede at least a small amount on
 * nearly every round by construction (verified by probing several
 * representative multi-round scenarios during the Milestone 5 design
 * review) — a genuine full stall is a rare edge case, not the normal
 * shape of a stalled-but-still-negotiating round. priorMerchantUnitPrice
 * is still accepted for forward compatibility but currently unused.
 *
 * SIZING (Buyer Quantity-for-Price Redesign): once every situational
 * gate above has passed, quantity and price are no longer a flat
 * doubling / flat 2% discount. Quantity uses
 * negotiationStrategy.resolveQuantityTradeIncreaseFraction — continuous
 * in the item's per-unit price (constraints.maxUnitPrice, the only
 * "ticket size" signal available without a new catalog field) and in the
 * base quantity itself, so an expensive item or an already-large order
 * gets a conservative relative increase, never a universal 2x. Price
 * uses negotiationStrategy.resolveQuantityTradePriceImprovementFraction
 * to improve on the round's own ordinary concession ask — but the result
 * is then additionally clamped to `previousBuyerUnitPrice`, the buyer's
 * OWN prior visible offer, whenever one exists: this is the hard
 * invariant the redesign exists to guarantee — a genuine quantity-for-
 * price trade must read as "give more, pay no more than I already said
 * I would," never "give more AND pay more." If the resulting price
 * (after that ceiling) is not a real, meaningful improvement over the
 * buyer's own previous offer, or the resulting quantity rounds to no
 * real increase at all, this correctly falls through to NO_TRADE rather
 * than firing a degenerate trade — see both checks below.
 */
export function decideBuyerQuantityTrade(
  constraints: BuyerConstraints,
  merchantOfferUnitPrice: number,
  merchantOfferedQuantity: number,
  concessionContext: BuyerConcessionContext,
  priorMerchantUnitPrice: number | null | undefined,
  /** The buyer's own previous-round unit price, if any — the hard upper bound this trade's price must never exceed. See this function's own doc comment. */
  previousBuyerUnitPrice: number | null | undefined,
  buyerLeverageScore: number | undefined,
  quantityTradeAlreadyUsed: boolean,
): BuyerQuantityTradeDecision {
  void priorMerchantUnitPrice; // accepted for forward compatibility — see the doc comment above.

  const noTrade = (reason: string): BuyerQuantityTradeDecision => ({
    move: "NO_TRADE",
    quantity: null,
    unitPrice: null,
    reason,
  });

  const roundsLeft = Math.max(1, concessionContext.maxRounds - concessionContext.round + 1);
  if (roundsLeft <= 2) {
    return noTrade("Too few rounds remain to introduce a new bargaining chip.");
  }

  if (quantityTradeAlreadyUsed) {
    return noTrade("The buyer has already used its quantity bargaining chip earlier in this negotiation.");
  }

  if (merchantOfferedQuantity < constraints.quantity) {
    return noTrade(
      "The merchant is already unable to fully supply the original request, so offering more quantity would not help.",
    );
  }

  const target = resolveBuyerTarget(constraints);
  if (merchantOfferUnitPrice <= target) {
    return noTrade("The merchant's offer is already close enough to the buyer's target; no need to trade for a better price.");
  }

  // No leverage signal at all is treated as ineligible — see the doc
  // comment above (a technical gate, not a strategic exclusion).
  if (buyerLeverageScore === undefined) {
    return noTrade("No buyer leverage signal is available to size the ask.");
  }

  const askMultiplier = resolveLeverageAskMultiplier(buyerLeverageScore);

  const increaseFraction = resolveQuantityTradeIncreaseFraction(
    constraints.maxUnitPrice,
    constraints.quantity,
    askMultiplier,
  );
  const tradeQuantity = Math.round(constraints.quantity * (1 + increaseFraction));
  if (tradeQuantity <= constraints.quantity) {
    return noTrade(
      "No meaningful quantity increase remains once bounded to a commercially conservative size for this order.",
    );
  }

  const normalAsk = computeBuyerConcessionPrice(constraints, merchantOfferUnitPrice, concessionContext);
  const priceImprovementFraction = resolveQuantityTradePriceImprovementFraction(askMultiplier, constraints.urgency);
  const upperBound =
    previousBuyerUnitPrice !== null && previousBuyerUnitPrice !== undefined
      ? Math.min(constraints.maxUnitPrice, previousBuyerUnitPrice)
      : constraints.maxUnitPrice;
  const tradeUnitPrice = clamp(Math.round(normalAsk * (1 - priceImprovementFraction)), target, upperBound);

  if (previousBuyerUnitPrice !== null && previousBuyerUnitPrice !== undefined) {
    const improvementRatio = (previousBuyerUnitPrice - tradeUnitPrice) / previousBuyerUnitPrice;
    if (improvementRatio < QUANTITY_TRADE_MIN_MEANINGFUL_PRICE_IMPROVEMENT_RATIO) {
      return noTrade(
        "The best price this trade could offer is not a meaningful improvement over the buyer's own last offer.",
      );
    }
  }

  return {
    move: "QUANTITY_FOR_PRICE",
    quantity: tradeQuantity,
    unitPrice: tradeUnitPrice,
    reason: `The buyer is offering to increase the order to ${tradeQuantity} units in exchange for a better unit price of ${tradeUnitPrice}.`,
  };
}
