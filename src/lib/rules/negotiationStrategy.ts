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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

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
// Quantity-for-price bargaining — PACT V2 Milestone 5, redesigned by the
// Buyer Quantity-for-Price Redesign (following a live calibration audit
// that found the original flat QUANTITY_TRADE_INCREASE_FRACTION=1.0 /
// QUANTITY_TRADE_PRICE_ASK_DISCOUNT=0.02 pair produced a universal 2x
// doubling and a price ask anchored to the round's own rising CONCEDE
// candidate rather than the buyer's own previous visible offer — the
// mechanical cause of every live-observed "buyer offers more AND its own
// price goes up" case. Both flat constants are gone; see
// resolveQuantityTradeIncreaseFraction / resolveQuantityTradePriceImprovementFraction
// below and their sole callers (buyerQuantityTrade.ts,
// buyerQuantityAndDeliveryTrade.ts) for the replacement.
//
// Deliberately independent of LARGE_ORDER_QUANTITY_THRESHOLD above: that
// constant gates a flat bulk-order posture at an absolute quantity; this
// gates a RELATIVE increase the buyer deliberately offers mid-negotiation,
// which can (and typically will) stay well below that absolute threshold.
// Calibration parameters of the strategy, not the mechanic itself — not
// sacred.
// ---------------------------------------------------------------------------

/** Reference "clearly low-ticket" per-unit price for the log-interpolated ticket-size scale below — never a per-SKU value, a calibration band. */
export const QUANTITY_TRADE_PRICE_SCALE_LOW_REFERENCE = 1000;
/** Reference "clearly high-ticket" per-unit price for the same scale. */
export const QUANTITY_TRADE_PRICE_SCALE_HIGH_REFERENCE = 50000;
/** Reference "small order" base quantity for the log-interpolated order-magnitude scale below. */
export const QUANTITY_TRADE_QTY_SCALE_SMALL_REFERENCE = 5;
/** Floor on the order-magnitude scale factor — a very large base order still gets a real (if small) relative increase, never zero. */
export const QUANTITY_TRADE_QTY_SCALE_MIN_FACTOR = 0.2;
/** Floor on the final increase fraction, after every scale factor and leverage have been applied — even the most conservative case (an expensive item, a very large base order, weak leverage) still offers a real, visible increase. */
export const QUANTITY_TRADE_MIN_INCREASE_FRACTION = 0.15;
/** Ceiling on the final increase fraction — reuses the old flat value as the UPPER bound (a cheap item, a small base order, strong leverage) rather than the universal one. */
export const QUANTITY_TRADE_MAX_INCREASE_FRACTION = 1.0;

/**
 * Ticket-size scale factor: 0 (very expensive per-unit price) to 1 (very
 * cheap), log-interpolated between QUANTITY_TRADE_PRICE_SCALE_LOW_REFERENCE
 * and QUANTITY_TRADE_PRICE_SCALE_HIGH_REFERENCE. Uses `maxUnitPrice` —
 * already a field on every BuyerConstraints, never a new catalog field —
 * as the ticket-size proxy: the negotiation core has no product
 * category/type today, and this codebase's own discipline forbids adding
 * one without proof of necessity (see the redesign's own design review).
 * Log, not linear, so the scale moves gradually across orders of
 * magnitude rather than reacting sharply to a small price difference.
 */
function quantityTradePriceScaleFactor(maxUnitPrice: number): number {
  return clamp(
    1 -
      Math.log10(maxUnitPrice / QUANTITY_TRADE_PRICE_SCALE_LOW_REFERENCE) /
        Math.log10(QUANTITY_TRADE_PRICE_SCALE_HIGH_REFERENCE / QUANTITY_TRADE_PRICE_SCALE_LOW_REFERENCE),
    0,
    1,
  );
}

/**
 * Order-magnitude scale factor: 1 (a small base order) down to
 * QUANTITY_TRADE_QTY_SCALE_MIN_FACTOR (a very large one), log-interpolated
 * between QUANTITY_TRADE_QTY_SCALE_SMALL_REFERENCE and
 * LARGE_ORDER_QUANTITY_THRESHOLD — reusing that existing constant rather
 * than inventing a second "what counts as large" threshold.
 */
function quantityTradeQuantityScaleFactor(baseQuantity: number): number {
  return clamp(
    1 -
      Math.log10(baseQuantity / QUANTITY_TRADE_QTY_SCALE_SMALL_REFERENCE) /
        Math.log10(LARGE_ORDER_QUANTITY_THRESHOLD / QUANTITY_TRADE_QTY_SCALE_SMALL_REFERENCE),
    QUANTITY_TRADE_QTY_SCALE_MIN_FACTOR,
    1,
  );
}

/**
 * How much more quantity the buyer offers, as a fraction of its own
 * original ask, when it uses its (single-use) quantity-for-price
 * bargaining chip — replaces the old flat QUANTITY_TRADE_INCREASE_FRACTION.
 * Continuous, never a per-SKU rule: expensive-per-unit items and very
 * large base orders scale toward QUANTITY_TRADE_MIN_INCREASE_FRACTION;
 * cheap items and small base orders can scale up to
 * QUANTITY_TRADE_MAX_INCREASE_FRACTION (the old universal value, now an
 * upper bound rather than a constant).
 *
 * `leverageAskMultiplier` is the ALREADY-RESOLVED output of
 * buyerQuantityTrade.resolveLeverageAskMultiplier — accepted here as a
 * plain number, never imported, since that function lives in a file that
 * itself imports from this one; computing it here would create a
 * circular import. The caller resolves it once and passes it to both
 * this function and resolveQuantityTradePriceImprovementFraction below.
 */
export function resolveQuantityTradeIncreaseFraction(
  maxUnitPrice: number,
  baseQuantity: number,
  leverageAskMultiplier: number,
): number {
  const baseIncrease =
    QUANTITY_TRADE_MIN_INCREASE_FRACTION +
    quantityTradePriceScaleFactor(maxUnitPrice) *
      (QUANTITY_TRADE_MAX_INCREASE_FRACTION - QUANTITY_TRADE_MIN_INCREASE_FRACTION);
  return clamp(
    baseIncrease * quantityTradeQuantityScaleFactor(baseQuantity) * leverageAskMultiplier,
    QUANTITY_TRADE_MIN_INCREASE_FRACTION,
    QUANTITY_TRADE_MAX_INCREASE_FRACTION,
  );
}

/** Baseline price-improvement fraction the quantity trade asks for, before leverage/urgency modulation — replaces the old flat QUANTITY_TRADE_PRICE_ASK_DISCOUNT (0.02), which anchored the ask to the round's own rising CONCEDE candidate with no real bite. */
export const QUANTITY_TRADE_PRICE_IMPROVEMENT_BASE = 0.15;
/** Floor on the resolved price-improvement fraction. */
export const QUANTITY_TRADE_MIN_PRICE_IMPROVEMENT_FRACTION = 0.05;
/** Ceiling on the resolved price-improvement fraction. */
export const QUANTITY_TRADE_MAX_PRICE_IMPROVEMENT_FRACTION = 0.3;
/** The smallest price improvement (relative to the buyer's own previous visible offer) that counts as a genuine exchange, not rounding noise — below this, the trade is not meaningfully different from what the buyer already offered, and must not fire. */
export const QUANTITY_TRADE_MIN_MEANINGFUL_PRICE_IMPROVEMENT_RATIO = 0.005;

/**
 * How aggressively the quantity trade's price ask improves on the
 * buyer's ordinary round-aware concession, before the hard
 * previousBuyerUnitPrice ceiling (enforced by the caller) is applied.
 * Two independent, continuous signals compose here:
 *
 *  - leverage (via the already-resolved leverageAskMultiplier, 0.5x-1.5x
 *    — the same curve buyerQuantityTrade.ts already used for its old,
 *    smaller discount): a stronger buyer can credibly push for more.
 *  - urgency: high urgency shrinks the improvement (an impatient buyer
 *    extracts less), low urgency grows it (a patient buyer bargains
 *    harder) — the direct inverse of resolveUrgencyConcessionFactor,
 *    kept consistent with that resolver's own meaning rather than a new,
 *    unrelated urgency effect. "medium" is the neutral 1.0 scale, same
 *    "medium is a no-op relative to the baseline" contract every other
 *    urgency resolver in this file already follows.
 *
 * This is deliberately the thing that changes; the hard ceiling
 * (previousBuyerUnitPrice, when one exists) is enforced by the caller,
 * never here — this function only ever proposes how much of the ROOM
 * between the round's own concession ask and the buyer's target to give
 * back, never a specific final price.
 */
export function resolveQuantityTradePriceImprovementFraction(
  leverageAskMultiplier: number,
  urgency: UrgencyLevel | undefined,
): number {
  const urgencyPriceScale = clamp(2 - resolveUrgencyConcessionFactor(urgency), 0.5, 1.5);
  return clamp(
    QUANTITY_TRADE_PRICE_IMPROVEMENT_BASE * leverageAskMultiplier * urgencyPriceScale,
    QUANTITY_TRADE_MIN_PRICE_IMPROVEMENT_FRACTION,
    QUANTITY_TRADE_MAX_PRICE_IMPROVEMENT_FRACTION,
  );
}

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
// Negotiation Engine V2 — shared leverage/round-progression factors, used
// by BOTH sides' middle-round concession formulas
// (computeMerchantConcessionPrice / computeBuyerConcessionPrice). Neither
// function is symmetric to the other (each keeps its own existing
// stock-pressure / urgency / reciprocity factors, its own anchor, its own
// direction) — these two functions only supply the two NEW ingredients
// each side folds in on top of what it already had. Both are pure,
// generic, and take every input explicitly (never re-deriving one side's
// leverage from the other via the 0-100 complementary relationship
// internally) — the caller supplies whichever pair of leverage scores
// belongs to it, in "own, opponent" order, matching the spec's
// `relativeStrength = ownLeverage - opponentLeverage` exactly.
// ---------------------------------------------------------------------------

/**
 * How much slower or faster a side should concede given its OWN leverage
 * relative to its opponent's, on a 0-100 scale each (leverage.ts's own
 * complementary buyer/merchant score). Symmetric in shape for both
 * sides — the caller decides which score is "own" and which is
 * "opponent." Centered at relativeStrength=0 (equal leverage) -> 1.0, a
 * complete no-op reproducing today's formula exactly; a side with
 * substantially MORE leverage than its opponent gets a SMALLER factor
 * (concedes less), a side with substantially LESS leverage gets a
 * LARGER factor (concedes more) — bounded to [0.5, 1.5], the same band
 * buyerQuantityTrade.ts's own resolveLeverageAskMultiplier already uses
 * for the identical "how much should leverage scale an ask" question,
 * kept consistent rather than inventing a new curve shape.
 */
export function resolveLeverageSpeedFactor(ownLeverage: number, opponentLeverage: number): number {
  const relativeStrength = ownLeverage - opponentLeverage;
  return clamp(1 - relativeStrength / 200, 0.5, 1.5);
}

/**
 * How much additional pressure to converge builds up purely from how far
 * through the negotiation's round budget the current round already is —
 * NOT "later round = concede more" on its own (that's exactly what this
 * codebase's existing final-2-rounds override already guarantees
 * unconditionally; this factor only ever applies in the middle-round
 * branch, never touching that override). Early rounds (roundProgress
 * near 0) land near 0.7 — real anchoring, smaller concessions, more room
 * to hold; later middle rounds (roundProgress approaching 1, i.e. right
 * up against the final-2-rounds cutoff) land near 1.3 — genuinely
 * greater pressure to close the gap while a real strategic choice still
 * exists. Bounded [0.7, 1.3] — the same band this codebase's own
 * stock-pressure speed factor already uses (0.7 low / 1.3 high), kept
 * consistent rather than inventing a new one. At the round/maxRounds
 * ratio every existing "middle round" test fixture in this codebase
 * already uses (round 2 of 4 -> roundProgress exactly 0.5), this
 * resolves to exactly 1.0 — a genuine no-op for every currently-pinned
 * shape assertion, not a coincidence avoided by opting out.
 */
export function resolveRoundProgressFactor(round: number, maxRounds: number): number {
  const roundProgress = clamp(round / Math.max(1, maxRounds), 0, 1);
  return clamp(0.7 + 0.6 * roundProgress, 0.7, 1.3);
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

// Exported so merchantDeliveryTradeEvaluator.ts (Milestone 7) can reuse
// the exact same per-day rate at its "medium stock" tier — the SAME
// baseline resolveDeliveryTrade already uses for every stock level —
// rather than duplicating the numbers.
export const DELIVERY_TRADE_DISCOUNT_PER_DAY_FRACTION = 0.01;
export const MAX_DELIVERY_TRADE_DISCOUNT_FRACTION = 0.15;

/**
 * A buyer who has explicitly signaled delivery flexibility, and whose
 * own deadline has real slack beyond the merchant's standard lead time,
 * can trade some of that slack for a price concession — up to the
 * merchant's maxDeliveryDays and never past the buyer's own deadline.
 * A no-op (standard delivery, zero discount) unless both conditions
 * hold, so no existing caller (none of which set buyerFlexible) is
 * affected.
 */
// ---------------------------------------------------------------------------
// Delivery-for-price bargaining — PACT V2 Milestone 7. resolveDeliveryTrade
// below (pre-existing) remains legacy infrastructure: an automatic,
// flat, merchant-state-blind discount applied whenever the buyer has
// simply FLAGGED flexibility, unchanged by this milestone — see
// merchantDeliveryTradeEvaluator.ts, which is what actually decides
// whether a DELIBERATE round-over-round delivery move is worth it to
// THIS merchant. These constants feed that evaluator and
// buyerDeliveryTrade.ts, not resolveDeliveryTrade.
// ---------------------------------------------------------------------------

/**
 * How much longer a delivery the buyer offers, as a fraction of its own
 * stated deadline, when it uses its (single-use) delivery-for-price
 * bargaining chip — at "medium" urgency. Kept as its own named constant
 * (rather than folded into resolveDeliveryUrgencyFactor below) because it
 * is still what every pre-existing caller/test in this codebase was
 * calibrated against, and it remains the one true baseline value
 * resolveDeliveryUrgencyFactor("medium") reproduces exactly.
 */
export const DELIVERY_TRADE_EXTENSION_FRACTION = 0.5;

/**
 * Urgency-driven delivery-extension willingness — how much of its own
 * stated deadline the buyer is willing to add when it trades delivery
 * for price, NOT how much it asks for in return (that stays
 * DELIVERY_TRADE_PRICE_ASK_DISCOUNT's own, unrelated question). This
 * REPLACES DELIVERY_TRADE_EXTENSION_FRACTION at the actual call site —
 * the two are never both multiplied together, which would silently
 * double-apply the fraction. Higher urgency means LESS willingness to
 * extend delivery at all — a genuinely time-pressured buyer has less
 * slack to trade away in the first place; low urgency (patient, can
 * wait) is willing to offer more. "medium" — the default whenever a
 * caller doesn't specify urgency, i.e. every pre-existing caller —
 * returns exactly DELIVERY_TRADE_EXTENSION_FRACTION (0.5), so every
 * existing scenario that predates this resolver is completely
 * unaffected (the same "medium is a no-op" contract
 * resolveUrgencyConcessionFactor / resolveQuantityShortfallTolerance
 * already follow).
 *
 * maxDeliveryDays remains the absolute, final ceiling regardless of this
 * factor — buyerDeliveryTrade.ts / buyerQuantityAndDeliveryTrade.ts still
 * clamp the resulting ask to it exactly as before, and a deadline already
 * AT maxDeliveryDays still always produces NO_TRADE for every urgency
 * level (this factor can only ever shrink or grow the RAW ask before
 * that clamp is applied — it can never bypass it).
 *
 * Values calibrated against a dedicated read-only probe (real
 * LAPTOP-14-I5 / MONITOR-24-FHD deadlines, swept across comfortable,
 * moderate, near-ceiling, and at-ceiling slack, real leverage, the real
 * comparator) — not hand-picked to pass one fixture. See that probe's
 * own report for the full evidence: every tested value left candidate
 * eligibility, the winning candidate, and price completely unaffected —
 * only the resulting deliveryDays term changed, and only in the
 * comfortable/moderate-slack regime where the maxDeliveryDays clamp
 * doesn't already dominate.
 */
export function resolveDeliveryUrgencyFactor(urgency: UrgencyLevel = "medium"): number {
  switch (urgency) {
    case "high":
      return 0.3;
    case "low":
      return 0.7;
    case "medium":
    default:
      return DELIVERY_TRADE_EXTENSION_FRACTION;
  }
}

/** Extra fractional discount, on top of the buyer's ordinary round-aware concession ask, requested in exchange for that additional delivery slack. */
export const DELIVERY_TRADE_PRICE_ASK_DISCOUNT = 0.02;

// ---------------------------------------------------------------------------
// Rush delivery: the inverse of the trade above. A buyer whose stated
// deadline is FASTER than the merchant's standardDeliveryDays is no
// longer an unconditional impossibility (see catalogRules.ts's
// checkDeliveryAchievable) — the merchant can expedite to meet it, at a
// price premium proportional to how many days faster than standard is
// being asked for. Scenario-behavior fix: without this, "urgent
// delivery" presets had no mechanism to demonstrate an actual cost for
// speed, since any deadline faster than standard was simply rejected
// outright before any negotiation could occur.
// ---------------------------------------------------------------------------

/** Rupee-fraction premium added per day faster than standard delivery — deliberately steeper than DELIVERY_TRADE_DISCOUNT_PER_DAY_FRACTION's own per-day discount (0.01): a real business commonly charges more per day for demonstrably harder-to-guarantee rush handling than it discounts for a buyer's mere convenience in waiting longer. */
export const RUSH_DELIVERY_PREMIUM_PER_DAY_FRACTION = 0.03;
/** Cap on the total rush premium, regardless of how aggressive the ask — mirrors MAX_DELIVERY_TRADE_DISCOUNT_FRACTION's own cap in the opposite direction, keeping both a symmetric, bounded band. */
export const MAX_RUSH_DELIVERY_PREMIUM_FRACTION = 0.15;

/**
 * Fractional premium (0 when the requested deadline is at or after
 * standardDeliveryDays — a genuine no-op for every existing caller/test,
 * matching every other resolve* factor in this file) applied to the
 * merchant's price band (listedPrice and minPrice both) for THIS
 * negotiation only — never mutates the catalog item itself. The caller
 * (merchantAgent.ts) derives an adjusted CatalogItemSnapshot from this
 * fraction and threads it through the existing, otherwise-unmodified
 * pricing formulas (computeCounterOfferPrice / computeMerchantConcessionPrice),
 * so no pricing formula needs to know about delivery urgency directly.
 */
export function resolveDeliveryRushPremiumFraction(
  standardDeliveryDays: number,
  requestedDeliveryDays: number,
): number {
  const daysFaster = Math.max(0, standardDeliveryDays - requestedDeliveryDays);
  return clamp(daysFaster * RUSH_DELIVERY_PREMIUM_PER_DAY_FRACTION, 0, MAX_RUSH_DELIVERY_PREMIUM_FRACTION);
}

/**
 * Merchant-side multiplier on the per-day delivery discount when stock is
 * genuinely CONSTRAINED (low) — deliberately the INVERSE of quantity's
 * own stock-pressure signal (ABUNDANT_STOCK_TRADE_MULTIPLIER in
 * merchantTradeEvaluator.ts): more quantity is straightforwardly more
 * revenue for an abundant-stock merchant, but extra delivery TIME mainly
 * helps a merchant that actually needs more lead time to source,
 * produce, or ship — an abundant-stock merchant that could already ship
 * on the standard schedule gains little from being given more time.
 * Sanity-checked (not tuned to one fixture) against several stock levels
 * and extension sizes before being set — see the Milestone 7 design
 * review and calibration probe.
 */
export const CONSTRAINED_STOCK_DELIVERY_TRADE_MULTIPLIER = 1.75;

/**
 * Multiplier when stock is ABUNDANT (high) — zero, deliberately: an
 * abundant-stock merchant has no genuine operational use for extra
 * delivery time, so it grants no additional price discount for it (still
 * accepts the later delivery date — that costs it nothing — just without
 * rewarding it financially). This is what keeps the evaluation a real
 * merchant-state judgment rather than a universal "+X days -> -Y rupees"
 * rule: the SAME extension proposal is worth something to a constrained
 * merchant and worth nothing to an abundant one.
 */
export const ABUNDANT_STOCK_DELIVERY_TRADE_MULTIPLIER = 0;

export function resolveDeliveryTrade(
  item: Pick<CatalogItemSnapshot, "standardDeliveryDays" | "maxDeliveryDays" | "listedPrice" | "minPrice">,
  buyerDeadlineDays: number,
  buyerFlexible: boolean,
): DeliveryTradeResult {
  // Scenario-behavior fix: a buyer deadline FASTER than standard is a
  // rush request, not a candidate for the (slower-for-discount) trade
  // below — the merchant meets it exactly, independent of buyerFlexible
  // (flexibility is only ever about willingness to accept a LATER date;
  // it has no bearing on whether a faster one can be met). The price
  // premium for this is not this function's concern: the caller
  // (merchantAgent.ts) already derives it into `item.listedPrice` /
  // `item.minPrice` before this function ever runs (see
  // resolveDeliveryRushPremiumFraction) — traded stays false here
  // (this isn't the buyer trading slack for a discount; it costs MORE,
  // not less), which also means leverage.ts's own deliveryFlexComponent
  // (traded ? 0.3 : 0) is completely unaffected by this branch.
  if (buyerDeadlineDays < item.standardDeliveryDays) {
    return { deliveryDays: buyerDeadlineDays, discount: 0, traded: false };
  }

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
