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
  DELIVERY_TRADE_EXTENSION_FRACTION,
  DELIVERY_TRADE_PRICE_ASK_DISCOUNT,
  QUANTITY_TRADE_INCREASE_FRACTION,
  QUANTITY_TRADE_PRICE_ASK_DISCOUNT,
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
 * SIZING reuses the exact same constants and formulas as the two solo
 * trades — QUANTITY_TRADE_INCREASE_FRACTION for the quantity give,
 * DELIVERY_TRADE_EXTENSION_FRACTION for the delivery give,
 * resolveLeverageAskMultiplier for how hard leverage lets the buyer
 * push. No new constant is invented for either give.
 *
 * The PRICE ask is deliberately NOT
 * `normalAsk - quantityDiscount - deliveryDiscount` (which would treat
 * the two discounts as independent amounts off the same anchor and
 * risk over-discounting) — it composes the two existing discount
 * fractions SEQUENTIALLY against the same buyer concession baseline
 * (apply the quantity discount, then apply the delivery discount to
 * what's left), the same "compose, don't sum, against one shared
 * baseline" principle the Milestone 12 design review required. Still
 * clamped to [target, maxUnitPrice], so it can never breach the buyer's
 * own hard ceiling no matter how the composition works out.
 */
export function decideBuyerQuantityAndDeliveryTrade(
  constraints: BuyerConstraints,
  merchantOfferUnitPrice: number,
  merchantOfferedQuantity: number,
  concessionContext: BuyerConcessionContext,
  buyerLeverageScore: number | undefined,
  quantityTradeAlreadyUsed: boolean,
  deliveryTradeAlreadyUsed: boolean,
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

  const tradeQuantity = Math.round(constraints.quantity * (1 + QUANTITY_TRADE_INCREASE_FRACTION));
  const extraDays = Math.max(1, Math.round(constraints.deliveryDeadlineDays * DELIVERY_TRADE_EXTENSION_FRACTION));
  const tradeDeliveryDays = constraints.deliveryDeadlineDays + extraDays;

  const normalAsk = computeBuyerConcessionPrice(constraints, merchantOfferUnitPrice, concessionContext);
  const askMultiplier = resolveLeverageAskMultiplier(buyerLeverageScore);
  const afterQuantityDiscount = normalAsk * (1 - QUANTITY_TRADE_PRICE_ASK_DISCOUNT * askMultiplier);
  const afterBothDiscounts = afterQuantityDiscount * (1 - DELIVERY_TRADE_PRICE_ASK_DISCOUNT * askMultiplier);
  const tradeUnitPrice = clamp(Math.round(afterBothDiscounts), target, constraints.maxUnitPrice);

  return {
    move: "QUANTITY_AND_DELIVERY_FOR_PRICE",
    quantity: tradeQuantity,
    deliveryDays: tradeDeliveryDays,
    unitPrice: tradeUnitPrice,
    reason: `The buyer is offering to increase the order to ${tradeQuantity} units and accept delivery in ${tradeDeliveryDays} days (instead of ${constraints.deliveryDeadlineDays}) in exchange for a better unit price of ${tradeUnitPrice}.`,
  };
}
