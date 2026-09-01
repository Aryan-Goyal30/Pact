// Buyer delivery-for-price bargaining — PACT V2 Milestone 7, Direction A.
//
// The second real conditional trade in this codebase, following
// buyerQuantityTrade.ts's exact shape: instead of only ever offering
// MORE QUANTITY for a better price, the buyer can offer a LONGER
// DELIVERY WINDOW for one instead. Deliberately its own module, not
// folded into buyerQuantityTrade.ts — the two dimensions share a
// convention (a small pure decision returning a named move + terms + a
// reason, and the leverage-sizing curve), not an implementation.
//
// Conceptually: "I originally needed it in 10 days, but I'll accept 15
// if you can lower the price" — a genuine give (more time) in exchange
// for a genuine ask (a better price), gated so it only fires when it's a
// deliberate, worthwhile move, never a quantity change explained after
// the fact.
//
// resolveDeliveryTrade (negotiationStrategy.ts) is deliberately NOT used
// or replaced here — that remains the legacy, always-on, merchant-state-
// blind formula for a buyer that has merely FLAGGED flexibility without
// making a deliberate round-over-round move. This module answers a
// different question: "is THIS a good moment to deliberately trade
// delivery time for price," mirroring buyerQuantityTrade.ts's own
// framing, not merchant-side reasoning (that's
// merchantDeliveryTradeEvaluator.ts).

import {
  computeBuyerConcessionPrice,
  resolveBuyerTarget,
  type BuyerConcessionContext,
  type BuyerConstraints,
} from "@/lib/rules/buyerRules";
import { resolveLeverageAskMultiplier } from "@/lib/rules/buyerQuantityTrade";
import {
  DELIVERY_TRADE_PRICE_ASK_DISCOUNT,
  resolveDeliveryUrgencyFactor,
} from "@/lib/rules/negotiationStrategy";

export type BuyerDeliveryTradeMove = "NO_TRADE" | "DELIVERY_FOR_PRICE";

export interface BuyerDeliveryTradeDecision {
  move: BuyerDeliveryTradeMove;
  /** The proposed (extended) delivery window, in days. Only meaningful when move is DELIVERY_FOR_PRICE; null for NO_TRADE. */
  deliveryDays: number | null;
  /** The price asked for in exchange. Null for NO_TRADE. Always within [target, maxUnitPrice]. */
  unitPrice: number | null;
  reason: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Decides whether the buyer should use its (single-use, per-negotiation)
 * delivery-for-price bargaining chip this round.
 *
 * A hard precondition unique to this dimension (quantity has no
 * equivalent): `constraints.deliveryFlexible` must already be true — the
 * buyer's own explicit, pre-stated willingness to consider a later date
 * at all. Unlike quantity (where any buyer might plausibly want to
 * commit to more), a buyer that never signaled openness to a later
 * delivery date isn't a candidate for this move.
 *
 * Beyond that: rounds remain beyond the final-two-round safety net; a
 * real price gap still exists; the chip has not already been used
 * earlier in this negotiation; and a leverage signal is available
 * (leverage sizes the ask, exactly like buyerQuantityTrade.ts — never a
 * binary eligibility gate; undefined leverage is still a technical, not
 * strategic, ineligibility).
 *
 * There is no delivery equivalent of quantity's "merchant already
 * short-supplying" gate — accepting a LATER date is never something the
 * merchant could be structurally unable to grant (unlike quantity, where
 * offering more when stock is already short is self-defeating), so no
 * such check exists here.
 *
 * `maxDeliveryDays` — the negotiation-hardening audit's own finding: the
 * buyer's raw extension math (deadline + a fixed fraction of it) has no
 * innate awareness of what the merchant could ever actually grant, and
 * could compute an ask past the product's real ceiling (observed live:
 * a 12-day deadline producing an 18-day ask against a product whose own
 * maxDeliveryDays is 12). This is PUBLIC information — the exact same
 * `maxDeliveryDays` field already returned by GET /api/manifest
 * (types/manifest.ts's PublicManifestProduct) — never `minPrice` or any
 * other private catalog field; the buyer already sees this number today,
 * it was simply never threaded into this particular formula. The result
 * is clamped to it, and if that clamp leaves no real extension over the
 * buyer's own stated deadline, this is correctly not a valid delivery
 * give at all — see the clamp below.
 *
 * `previousBuyerUnitPrice` (Negotiation Engine V2, D5) — the same hard
 * invariant buyerQuantityTrade.ts / buyerQuantityAndDeliveryTrade.ts
 * already enforce: a conditional trade must read as "give something
 * more, pay no more than I already said I would," never "give more AND
 * pay more." Previously this trade's price was only ever bounded by
 * `constraints.maxUnitPrice`, so it could ask for a price ABOVE the
 * buyer's own last visible offer whenever the round's ordinary ask
 * happened to be high — a real, observed inconsistency (the "trade" then
 * reads as a price increase, not a concession, from the buyer's own
 * stated position). The upper bound is now the tighter of the two —
 * `constraints.maxUnitPrice` when no previous offer exists yet (identical
 * to the pre-D5 behavior), otherwise `previousBuyerUnitPrice` — exactly
 * mirroring the sibling trades' own clamp.
 */
export function decideBuyerDeliveryTrade(
  constraints: BuyerConstraints,
  merchantOfferUnitPrice: number,
  concessionContext: BuyerConcessionContext,
  previousBuyerUnitPrice: number | null | undefined,
  buyerLeverageScore: number | undefined,
  deliveryTradeAlreadyUsed: boolean,
  maxDeliveryDays: number,
): BuyerDeliveryTradeDecision {
  const noTrade = (reason: string): BuyerDeliveryTradeDecision => ({
    move: "NO_TRADE",
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

  if (deliveryTradeAlreadyUsed) {
    return noTrade("The buyer has already used its delivery bargaining chip earlier in this negotiation.");
  }

  const target = resolveBuyerTarget(constraints);
  if (merchantOfferUnitPrice <= target) {
    return noTrade("The merchant's offer is already close enough to the buyer's target; no need to trade for a better price.");
  }

  if (buyerLeverageScore === undefined) {
    return noTrade("No buyer leverage signal is available to size the ask.");
  }

  // Urgency-driven extension willingness (negotiation calibration audit):
  // high urgency asks for less extra time, low urgency for more —
  // "medium" reproduces the exact pre-existing DELIVERY_TRADE_EXTENSION_FRACTION
  // value, so every caller that predates this factor is unaffected. See
  // resolveDeliveryUrgencyFactor's own doc comment for the full reasoning
  // and calibration evidence.
  const extraDays = Math.max(
    1,
    Math.round(constraints.deliveryDeadlineDays * resolveDeliveryUrgencyFactor(constraints.urgency)),
  );
  const tradeDeliveryDays = Math.min(constraints.deliveryDeadlineDays + extraDays, maxDeliveryDays);
  if (tradeDeliveryDays <= constraints.deliveryDeadlineDays) {
    // The merchant's real ceiling leaves no genuine extension over the
    // buyer's own stated deadline to offer — not a valid delivery give
    // (see this function's own doc comment on maxDeliveryDays), never a
    // new trade type or a silently-truncated one.
    return noTrade("The merchant's maximum delivery window leaves no real slack beyond the buyer's own deadline to trade.");
  }
  const normalAsk = computeBuyerConcessionPrice(constraints, merchantOfferUnitPrice, concessionContext);
  const askMultiplier = resolveLeverageAskMultiplier(buyerLeverageScore);
  const upperBound =
    previousBuyerUnitPrice !== null && previousBuyerUnitPrice !== undefined
      ? Math.min(constraints.maxUnitPrice, previousBuyerUnitPrice)
      : constraints.maxUnitPrice;
  const tradeUnitPrice = clamp(
    Math.round(normalAsk * (1 - DELIVERY_TRADE_PRICE_ASK_DISCOUNT * askMultiplier)),
    target,
    upperBound,
  );

  return {
    move: "DELIVERY_FOR_PRICE",
    deliveryDays: tradeDeliveryDays,
    unitPrice: tradeUnitPrice,
    reason: `The buyer is offering to accept delivery in ${tradeDeliveryDays} days (instead of ${constraints.deliveryDeadlineDays}) in exchange for a better unit price of ${tradeUnitPrice}.`,
  };
}
