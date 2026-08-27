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
// Quantity-for-price bargaining — PACT V2 Milestone 5. Deliberately
// independent of LARGE_ORDER_QUANTITY_THRESHOLD above: that constant
// gates a flat bulk-order posture at an absolute quantity; these gate a
// RELATIVE increase the buyer deliberately offers mid-negotiation, which
// can (and typically will) stay well below that absolute threshold — see
// buyerQuantityTrade.ts. Calibration parameters of the strategy, not the
// mechanic itself — sanity-checked against several representative
// scenarios (not just one fixture) before being set; not sacred.
// ---------------------------------------------------------------------------

/** How much more quantity the buyer offers, as a fraction of its original ask, when it uses its (single-use) quantity-for-price bargaining chip. */
export const QUANTITY_TRADE_INCREASE_FRACTION = 1.0;

/** Extra fractional discount, on top of the buyer's ordinary round-aware concession ask, requested in exchange for that additional quantity. */
export const QUANTITY_TRADE_PRICE_ASK_DISCOUNT = 0.02;

// ---------------------------------------------------------------------------
// Quantity SUFFICIENCY — PACT V2 Milestone 6. Deliberately a SEPARATE
// concept from the quantity-for-price bargaining chip above: this is
// "how much shortfall from what I actually need can I tolerate," not
// "how much extra am I willing to offer." See buyerQuantitySufficiency.ts.
//
// Tolerance is expressed as a FRACTION of the buyer's originally
// requested quantity, keyed off the same urgency categories every other
// urgency-driven factor in this codebase already uses
// (resolveUrgencyConcessionFactor). High urgency tolerates more
// shortfall (time pressure matters more than getting the exact amount);
// low urgency tolerates less (a patient buyer can afford to hold out for
// the full quantity). Sanity-checked against several representative
// shortfall/price combinations (not just one fixture) before being set
// — see the Milestone 6 design review — and, like every other
// calibration constant in this file, not sacred.
// ---------------------------------------------------------------------------

export const QUANTITY_SHORTFALL_TOLERANCE_HIGH_URGENCY = 0.35;
export const QUANTITY_SHORTFALL_TOLERANCE_MEDIUM_URGENCY = 0.2;
export const QUANTITY_SHORTFALL_TOLERANCE_LOW_URGENCY = 0.1;

/**
 * The default shortfall tolerance for a buyer that hasn't stated an
 * explicit one (BuyerConstraints.quantityShortfallTolerance) — derived
 * purely from urgency, the same "medium is the neutral default" shape
 * every other urgency-driven factor in this file already follows.
 */
export function resolveQuantityShortfallTolerance(urgency: UrgencyLevel = "medium"): number {
  switch (urgency) {
    case "high":
      return QUANTITY_SHORTFALL_TOLERANCE_HIGH_URGENCY;
    case "low":
      return QUANTITY_SHORTFALL_TOLERANCE_LOW_URGENCY;
    case "medium":
    default:
      return QUANTITY_SHORTFALL_TOLERANCE_MEDIUM_URGENCY;
  }
}

/**
 * How close to the buyer's own aspirational target (not merely under its
 * hard ceiling) a price needs to be to be considered "substantially
 * better" enough to justify accepting a shortfall that only barely
 * exceeds ordinary tolerance. 0 = at the ceiling (no advantage at all),
 * 1 = at or below the target (the best the buyer could realistically
 * hope for). This is the BASELINE requirement — see
 * QUANTITY_SHORTFALL_PRICE_COMPENSATION_SEVERITY_SCALING for how it
 * rises as the shortfall gets more severe, so a severe shortfall is
 * never treated the same as a marginal one just because both exceed
 * tolerance.
 */
export const QUANTITY_SHORTFALL_PRICE_COMPENSATION_THRESHOLD = 0.65;

/**
 * How much the required price advantage rises per unit of shortfall
 * beyond tolerance — e.g. a shortfall 20 percentage points beyond
 * tolerance raises the bar by 20 * 1.5 = 30 percentage points. This is
 * what makes a severe shortfall (well beyond tolerance) require a price
 * advantage the [0,1] scale cannot reach at all — no price ever
 * compensates for it — while a shortfall only just beyond tolerance
 * still has a real, reachable bar to clear. Sanity-checked (not
 * hand-picked to pass one fixture) against shortfalls ranging from just
 * over tolerance to near-total (150 requested / 10 offered).
 */
export const QUANTITY_SHORTFALL_PRICE_COMPENSATION_SEVERITY_SCALING = 1.5;

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
