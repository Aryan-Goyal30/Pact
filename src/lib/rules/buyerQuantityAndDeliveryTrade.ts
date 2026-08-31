// Buyer combined quantity+delivery-for-price bargaining — PACT V2
// Milestone 12.
//
// The first genuinely multi-dimensional bargaining move in this
// codebase: instead of giving up exactly one non-price thing
// (buyerQuantityTrade.ts's extra quantity, XOR buyerDeliveryTrade.ts's
// extra delivery slack) for a better price, the buyer offers BOTH
// together, in one conditional move — "I'll take 200 units and accept
// 12-day delivery if you can do 43000."
//
// Deliberately its own module, mirroring the SHAPE of the two solo trade
// modules (a small pure decision returning a named move + a package + a
// reason), not folded into either — same discipline
// merchantDeliveryTradeEvaluator.ts's own module comment already
// establishes: sharing the CONVENTION, never the implementation, avoids
// becoming "a pile of unrelated formulas."
//
// Eligibility is the INTERSECTION of both solo trades' own preconditions
// (see decideBuyerQuantityAndDeliveryTrade's doc comment) — never a new
// waterfall rule about WHEN to prefer combining over trading just one
// dimension. That question is answered downstream, by the existing,
// unmodified compareBuyerPackages (buyerMoveSelection.ts), exactly the
// same way it already decides between the two solo trades today: this
// candidate is generated whenever it's genuinely constructible, and
// added to the SAME pool as every other candidate — never selected here.

import {
  computeBuyerConcessionPrice,
  resolveBuyerTarget,
  type BuyerConcessionContext,
  type BuyerConstraints,
} from "@/lib/rules/buyerRules";
import { resolveLeverageAskMultiplier } from "@/lib/rules/buyerQuantityTrade";
import {
  DELIVERY_TRADE_PRICE_ASK_DISCOUNT,
  QUANTITY_TRADE_MIN_MEANINGFUL_PRICE_IMPROVEMENT_RATIO,
  resolveDeliveryUrgencyFactor,
  resolveQuantityTradeIncreaseFraction,
  resolveQuantityTradePriceImprovementFraction,
} from "@/lib/rules/negotiationStrategy";

export type BuyerPackageTradeMove = "NO_TRADE" | "QUANTITY_AND_DELIVERY_FOR_PRICE";

export interface BuyerQuantityAndDeliveryTradeDecision {
  move: BuyerPackageTradeMove;
  /** The proposed order quantity. Only meaningful when move fires; null for NO_TRADE. */
  quantity: number | null;
  /** The proposed (extended) delivery window, in days. Only meaningful when move fires; null for NO_TRADE. */
  deliveryDays: number | null;
  /** The price asked for in exchange for BOTH gives. Null for NO_TRADE. Always within [target, maxUnitPrice]. */
  unitPrice: number | null;
  reason: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Decides whether the buyer should offer its combined quantity+delivery
 * package this round — using BOTH its (single-use, per-negotiation)
 * quantity and delivery bargaining chips together, in one conditional
 * move, rather than either alone.
 *
 * ELIGIBILITY is the INTERSECTION of decideBuyerQuantityTrade's own
 * situational gates and decideBuyerDeliveryTrade's own situational
 * gates — every one of them, unchanged:
 *  - rounds remain beyond the final-two-round safety net;
 *  - the buyer has explicitly signaled delivery flexibility
 *    (constraints.deliveryFlexible) — the combined form has no meaning
 *    without it, exactly like the solo delivery trade;
 *  - NEITHER chip has already been used earlier in this negotiation —
 *    a combined offer consumes both at once, so both must still be
 *    available (see generateBuyerCandidates for how "already used" is
 *    derived from real history, unchanged);
 *  - the merchant is not already short-supplying the buyer's ORIGINAL
 *    request — offering even more quantity when stock is already
 *    constrained is self-defeating, the exact same reason
 *    decideBuyerQuantityTrade refuses to fire during partial
 *    fulfillment. This is what keeps a combined package from ever
 *    becoming "partial fulfillment + quantity increase + delivery
 *    change" in one accidental move (Milestone 12 design review,
 *    section 11) — it simply never becomes eligible.
 *  - a real price gap still exists;
 *  - a leverage signal is available to size the ask (the same
 *    technical, not strategic, gate both solo trades already use).
 *
 * SIZING (Buyer Quantity-for-Price Redesign): the quantity give reuses
 * negotiationStrategy.resolveQuantityTradeIncreaseFraction — the EXACT
 * SAME resolver buyerQuantityTrade.ts's own solo trade uses, never a
 * second, independently-drifting quantity-sizing formula. The delivery
 * give is completely UNCHANGED: resolveDeliveryUrgencyFactor,
 * maxDeliveryDays clamping, and the extraDays math are exactly what the
 * solo delivery trade already used. resolveLeverageAskMultiplier still
 * decides how hard leverage lets the buyer push, on both dimensions.
 *
 * The delivery give's raw extension math is clamped to `maxDeliveryDays`
 * exactly like buyerDeliveryTrade.ts's own solo trade — see that
 * function's doc comment for why (a real, live-observed over-ceiling
 * ask) and why this is safe, public information to use here. If the
 * clamp leaves no real extension, the combined package correctly does
 * not fire (see the check below) — the quantity dimension alone is
 * never repackaged as a delivery give that isn't genuinely one.
 *
 * The PRICE ask is deliberately NOT
 * `normalAsk - quantityImprovement - deliveryDiscount` (which would treat
 * the two as independent amounts off the same anchor and risk
 * over-discounting) — it composes them SEQUENTIALLY against the same
 * buyer concession baseline (apply the quantity-driven price-improvement
 * fraction — negotiationStrategy.resolveQuantityTradePriceImprovementFraction,
 * the same one the solo quantity trade uses — then apply the delivery
 * discount to what's left), the same "compose, don't sum, against one
 * shared baseline" principle the Milestone 12 design review required.
 * The composed result is then clamped to `previousBuyerUnitPrice`
 * (the buyer's own prior visible offer), exactly like the solo quantity
 * trade's own hard invariant — see decideBuyerQuantityTrade's doc
 * comment for why. Still finally clamped to [target, maxUnitPrice], so
 * it can never breach the buyer's own hard ceiling no matter how the
 * composition works out.
 */
export function decideBuyerQuantityAndDeliveryTrade(
  constraints: BuyerConstraints,
  merchantOfferUnitPrice: number,
  merchantOfferedQuantity: number,
  concessionContext: BuyerConcessionContext,
  /** The buyer's own previous-round unit price, if any — the hard upper bound the composed trade price must never exceed. See decideBuyerQuantityTrade's doc comment for why. */
  previousBuyerUnitPrice: number | null | undefined,
  buyerLeverageScore: number | undefined,
  quantityTradeAlreadyUsed: boolean,
  deliveryTradeAlreadyUsed: boolean,
  /** Public information — see buyerDeliveryTrade.ts's decideBuyerDeliveryTrade for why this is safe to pass and why it's needed. */
  maxDeliveryDays: number,
): BuyerQuantityAndDeliveryTradeDecision {
  const noTrade = (reason: string): BuyerQuantityAndDeliveryTradeDecision => ({
    move: "NO_TRADE",
    quantity: null,
    deliveryDays: null,
    unitPrice: null,
    reason,
  });

  if (!constraints.deliveryFlexible) {
    return noTrade("The buyer has not indicated any delivery flexibility.");
  }

  const roundsLeft = Math.max(1, concessionContext.maxRounds - concessionContext.round + 1);
  if (roundsLeft <= 2) {
    return noTrade("Too few rounds remain to introduce a new bargaining chip.");
  }

  if (quantityTradeAlreadyUsed || deliveryTradeAlreadyUsed) {
    return noTrade(
      "The buyer has already used at least one of its bargaining chips earlier in this negotiation, so the combined package is no longer available.",
    );
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

  if (buyerLeverageScore === undefined) {
    return noTrade("No buyer leverage signal is available to size the ask.");
  }

  // Same urgency-driven extension willingness as buyerDeliveryTrade.ts's
  // own solo trade — the two must stay semantically aligned; see
  // resolveDeliveryUrgencyFactor's own doc comment.
  const extraDays = Math.max(
    1,
    Math.round(constraints.deliveryDeadlineDays * resolveDeliveryUrgencyFactor(constraints.urgency)),
  );
  const tradeDeliveryDays = Math.min(constraints.deliveryDeadlineDays + extraDays, maxDeliveryDays);
  if (tradeDeliveryDays <= constraints.deliveryDeadlineDays) {
    // Same reasoning as buyerDeliveryTrade.ts's own solo trade: no real
    // delivery slack left to trade means this isn't a genuine combined
    // give — never silently degrade to a quantity-only trade under this
    // move's own name.
    return noTrade("The merchant's maximum delivery window leaves no real slack beyond the buyer's own deadline to trade, so the combined package is not available.");
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
  const quantityPriceImprovementFraction = resolveQuantityTradePriceImprovementFraction(
    askMultiplier,
    constraints.urgency,
  );
  const afterQuantityDiscount = normalAsk * (1 - quantityPriceImprovementFraction);
  const afterBothDiscounts = afterQuantityDiscount * (1 - DELIVERY_TRADE_PRICE_ASK_DISCOUNT * askMultiplier);
  const upperBound =
    previousBuyerUnitPrice !== null && previousBuyerUnitPrice !== undefined
      ? Math.min(constraints.maxUnitPrice, previousBuyerUnitPrice)
      : constraints.maxUnitPrice;
  const tradeUnitPrice = clamp(Math.round(afterBothDiscounts), target, upperBound);

  if (previousBuyerUnitPrice !== null && previousBuyerUnitPrice !== undefined) {
    const improvementRatio = (previousBuyerUnitPrice - tradeUnitPrice) / previousBuyerUnitPrice;
    if (improvementRatio < QUANTITY_TRADE_MIN_MEANINGFUL_PRICE_IMPROVEMENT_RATIO) {
      return noTrade(
        "The best price this combined package could offer is not a meaningful improvement over the buyer's own last offer.",
      );
    }
  }

  return {
    move: "QUANTITY_AND_DELIVERY_FOR_PRICE",
    quantity: tradeQuantity,
    deliveryDays: tradeDeliveryDays,
    unitPrice: tradeUnitPrice,
    reason: `The buyer is offering to increase the order to ${tradeQuantity} units and accept delivery in ${tradeDeliveryDays} days (instead of ${constraints.deliveryDeadlineDays}) in exchange for a better unit price of ${tradeUnitPrice}.`,
  };
}
