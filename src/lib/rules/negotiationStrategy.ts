// Deterministic strategic-factor overlays — negotiation strategy
// hardening, following the Agreement + AuditLog milestone.
//
// Everything here is a pure, synchronous function, same discipline as
// negotiationEngine.ts / buyerRules.ts / catalogRules.ts: no LLM, no
// randomness, no I/O. This module does not decide outcomes on its own —
// it computes NUMBERS and EXPLANATIONS that buyerRules.ts's
// computeBuyerConcessionPrice and negotiationEngine.ts's
// computeMerchantConcessionPrice feed into their existing clamped
// formulas. The final [minPrice, listedPrice] / [target, maxUnitPrice]
// clamps in those two functions are what actually guarantee the hard
// constraints (never below the merchant's floor, never above the
// buyer's ceiling) — nothing in this file can bypass them.
//
// Calibration note: every threshold below is chosen so that the
// existing catalog fixtures used throughout the test suite (availableQty
// of 50, 100, or 250; requested quantities up to 200 — including the
// flagship "200 laptops, 100 available" demo scenario pinned in
// orchestrator.test.ts) land in the neutral/no-op band. The new
// strategic behavior is real and does change outcomes, but only once an
// input is genuinely large or skewed relative to what the existing demo
// data uses — see negotiationStrategy.test.ts for fixtures deliberately
// chosen to cross these thresholds.

import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";

export type UrgencyLevel = "low" | "medium" | "high";
export type PressureLevel = "low" | "medium" | "high";

// ---------------------------------------------------------------------------
// Buyer-side factors
// ---------------------------------------------------------------------------

/**
 * How fast the buyer moves toward its ceiling each round, as a
 * multiplier on the existing "concede half the remaining gap" step.
 * "medium" (the default whenever a caller doesn't specify urgency, i.e.
 * every pre-existing caller) reproduces a multiplier of exactly 1 — the
 * plain halving formula computeBuyerConcessionPrice already used before
 * this factor existed.
 *
 * High urgency -> less aggressive on price (moves toward its ceiling
 * faster). Low urgency -> stronger bargaining (holds nearer its target
 * for longer).
 */
export function resolveUrgencyConcessionFactor(urgency: UrgencyLevel = "medium"): number {
  switch (urgency) {
    case "high":
      return 1.4;
    case "low":
      return 0.65;
    case "medium":
    default:
      return 1.0;
  }
}

/** Order size at/above which a buyer or merchant gains genuine quantity leverage. */
export const LARGE_ORDER_QUANTITY_THRESHOLD = 300;

/** Extra fractional pull on the buyer's aspirational target for a large order. */
export const LARGE_ORDER_TARGET_DISCOUNT = 0.03;

/** Extra fractional discount (of the merchant's listed-minus-floor margin) for a large order. */
export const LARGE_ORDER_MERCHANT_DISCOUNT = 0.04;

export function hasQuantityLeverage(quantity: number): boolean {
  return quantity >= LARGE_ORDER_QUANTITY_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Merchant-side factors
// ---------------------------------------------------------------------------

const MERCHANT_STOCK_LOW = 30;
const MERCHANT_STOCK_HIGH = 300;

/**
 * Reads inventory pressure purely from the item's own available stock —
 * deliberately independent of any single buyer's requested quantity, so
 * one large order never itself swings the merchant's general stock
 * posture (see the calibration note above). "medium" — the band every
 * existing catalog fixture falls into — is a no-op relative to today's
 * behavior.
 */
export function resolveMerchantStockPressure(
  item: Pick<CatalogItemSnapshot, "availableQty">,
): PressureLevel {
  if (item.availableQty <= MERCHANT_STOCK_LOW) return "low";
  if (item.availableQty > MERCHANT_STOCK_HIGH) return "high";
  return "medium";
}

/**
 * Demand pressure is read as the complementary narrative to stock
 * pressure: scarce stock reads as high demand pressure (the merchant
 * holds firmer), abundant stock reads as low demand pressure (the
 * merchant is more willing to move) — the same underlying signal as
 * resolveMerchantStockPressure, not an independent one. There is no real
 * demand-history data in this system to derive a genuinely separate
 * signal from, and tying "demand" to the CURRENT buyer's own requested
 * quantity would make one buyer's order size retroactively change how
 * firm the merchant is against that same buyer — an incoherent feedback
 * loop this deliberately avoids.
 */
export function resolveMerchantDemandPressure(
  item: Pick<CatalogItemSnapshot, "availableQty">,
): PressureLevel {
  const stock = resolveMerchantStockPressure(item);
  if (stock === "low") return "high";
  if (stock === "high") return "low";
  return "medium";
}

/**
 * Multiplier on the merchant's "concede half the remaining gap" step,
 * driven by stock pressure. High stock (stock-clearance pressure)
 * concedes faster; low stock (scarcity / high demand) holds firmer.
 * "medium" reproduces a multiplier of exactly 1.
 */
export function resolveMerchantConcessionSpeedFactor(
  item: Pick<CatalogItemSnapshot, "availableQty">,
): number {
  const stock = resolveMerchantStockPressure(item);
  if (stock === "high") return 1.3;
  if (stock === "low") return 0.7;
  return 1.0;
}

// ---------------------------------------------------------------------------
// Multi-variable trade: delivery flexibility for a price concession.
// ---------------------------------------------------------------------------

export interface DeliveryTradeResult {
  deliveryDays: number;
  /** Rupee amount to additionally subtract from the concession price — still subject to the caller's final minPrice clamp. */
  discount: number;
  traded: boolean;
}

const DELIVERY_TRADE_DISCOUNT_PER_DAY_FRACTION = 0.01;
const MAX_DELIVERY_TRADE_DISCOUNT_FRACTION = 0.15;

/**
 * A buyer who has explicitly signaled delivery flexibility, and whose
 * own deadline has real slack beyond the merchant's standard lead time,
 * can trade some of that slack for a price concession — up to the
 * merchant's maxDeliveryDays and never past the buyer's own deadline.
 * A no-op (standard delivery, zero discount) unless both conditions
 * hold, so no existing caller (none of which set buyerFlexible) is
 * affected.
 */
export function resolveDeliveryTrade(
  item: Pick<CatalogItemSnapshot, "standardDeliveryDays" | "maxDeliveryDays" | "listedPrice" | "minPrice">,
  buyerDeadlineDays: number,
  buyerFlexible: boolean,
): DeliveryTradeResult {
  if (!buyerFlexible || buyerDeadlineDays <= item.standardDeliveryDays) {
    return { deliveryDays: item.standardDeliveryDays, discount: 0, traded: false };
  }

  const extendedDeliveryDays = Math.min(item.maxDeliveryDays, buyerDeadlineDays);
  const extraDays = extendedDeliveryDays - item.standardDeliveryDays;
  if (extraDays <= 0) {
    return { deliveryDays: item.standardDeliveryDays, discount: 0, traded: false };
  }

  const margin = item.listedPrice - item.minPrice;
  const discountFraction = Math.min(
    extraDays * DELIVERY_TRADE_DISCOUNT_PER_DAY_FRACTION,
    MAX_DELIVERY_TRADE_DISCOUNT_FRACTION,
  );
  return {
    deliveryDays: extendedDeliveryDays,
    discount: margin * discountFraction,
    traded: true,
  };
}

// ---------------------------------------------------------------------------
// Human-readable strategic reasons — "which factors were actually used
// this round," for the agent-level response objects
// (MerchantAgentResponse.decision.reasons / BuyerAgentResponse.strategicReasons)
// to carry alongside the structured numbers.
// ---------------------------------------------------------------------------

export function explainMerchantFactors(
  item: Pick<CatalogItemSnapshot, "availableQty">,
  quantityLeveraged: boolean,
  trade: DeliveryTradeResult,
): string[] {
  const reasons: string[] = [];
  const stock = resolveMerchantStockPressure(item);
  if (stock === "high") {
    reasons.push("Merchant has high stock pressure and increased its concession.");
  } else if (stock === "low") {
    reasons.push("Merchant is holding firm because inventory is limited and demand is high.");
  }
  if (quantityLeveraged) {
    reasons.push("Large order quantity qualifies for an additional quantity discount.");
  }
  if (trade.traded) {
    reasons.push(
      `Merchant offered a lower price in exchange for a longer delivery window of ${trade.deliveryDays} day(s).`,
    );
  }
  return reasons;
}

export function explainBuyerFactors(
  urgency: UrgencyLevel | undefined,
  quantityLeveraged: boolean,
  roundsLeft: number,
): string[] {
  const reasons: string[] = [];
  const resolvedUrgency = urgency ?? "medium";
  if (resolvedUrgency === "low") {
    reasons.push("Buyer urgency is low, allowing stronger price negotiation.");
  } else if (resolvedUrgency === "high") {
    reasons.push("Buyer urgency is high, so it is less aggressive on price.");
  }
  if (quantityLeveraged) {
    reasons.push("Large order quantity provides the buyer additional leverage.");
  }
  if (roundsLeft <= 2) {
    reasons.push(
      "Few negotiation rounds remain; the buyer is moving toward its true ceiling rather than risk losing the deal.",
    );
  }
  return reasons;
}
