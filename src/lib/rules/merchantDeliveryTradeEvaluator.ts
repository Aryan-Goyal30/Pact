// Merchant delivery-for-price trade evaluator — PACT V2 Milestone 7,
// Direction A.
//
// Mirrors merchantTradeEvaluator.ts's role (Milestone 1's "is this deal
// worth it" question) for the delivery dimension: instead of a flat,
// merchant-state-blind per-day discount (resolveDeliveryTrade,
// negotiationStrategy.ts — deliberately left as legacy infrastructure,
// untouched), this asks "is the extra delivery time the buyer is
// offering actually valuable to ME, given my own operational state?"
// before deciding how far to move on price for it.
//
// Deliberately its own module, not folded into merchantTradeEvaluator.ts
// — that file's own name and MerchantTradeProposal type are specifically
// quantity-shaped, and force-fitting delivery into it would be exactly
// the "pile of unrelated formulas" this milestone was warned against.
// Shares the CONVENTION (ACCEPT/COUNTER/HOLD/REJECT verdict + unitPrice
// + reason), not the implementation.
//
// Key deliberate asymmetry from the quantity evaluator's own stock-
// pressure signal: more quantity is straightforwardly more revenue for
// an abundant-stock merchant. Extra delivery TIME mainly helps a
// merchant that is genuinely CONSTRAINED — needs more lead time to
// source, produce, or ship. An abundant-stock merchant that could
// already ship on the standard schedule gains little from being given
// more time. See CONSTRAINED_STOCK_DELIVERY_TRADE_MULTIPLIER /
// ABUNDANT_STOCK_DELIVERY_TRADE_MULTIPLIER (negotiationStrategy.ts) —
// sanity-checked against several stock levels before being set, not
// tuned to one fixture.

import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import {
  ABUNDANT_STOCK_DELIVERY_TRADE_MULTIPLIER,
  CONSTRAINED_STOCK_DELIVERY_TRADE_MULTIPLIER,
  DELIVERY_TRADE_DISCOUNT_PER_DAY_FRACTION,
  MAX_DELIVERY_TRADE_DISCOUNT_FRACTION,
  resolveMerchantStockPressure,
} from "@/lib/rules/negotiationStrategy";

export type MerchantDeliveryTradeVerdict = "ACCEPT" | "COUNTER" | "HOLD" | "REJECT";

/** The delivery <-> price trade being evaluated: how many days beyond the merchant's own standard lead time the buyer is offering, and the price it's asking for in exchange. */
export interface MerchantDeliveryTradeProposal {
  /** Already clamped to the merchant's own maxDeliveryDays by the caller (resolveDeliveryTrade) — never re-derived here, avoiding a second, possibly-diverging clamp. */
  extraDays: number;
  unitPrice: number;
}

export interface MerchantDeliveryTradeContext {
  /**
   * What the merchant's ordinary, DELIVERY-blind round-aware concession
   * price would be this round — i.e. computeMerchantConcessionPrice's
   * output WITHOUT a deliveryTradeDiscount in its context (stock-pressure
   * speed factor and reciprocity still apply; only the delivery-driven
   * adjustment is excluded, since that's what this function decides
   * instead). Mirrors merchantTradeEvaluator.ts's own
   * baselineConcessionPrice exactly, for the delivery dimension.
   */
  baselineConcessionPrice: number;
}

export interface MerchantDeliveryTradeEvaluation {
  verdict: MerchantDeliveryTradeVerdict;
  /** The unit price the merchant is willing to offer given this verdict. Always clamped to [item.minPrice, item.listedPrice]. */
  unitPrice: number;
  /** Human-readable explanation — feeds NegotiationResult.reasons, which the LLM phrases. Never contains a number the LLM shouldn't already have. */
  reason: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Evaluates whether the extra delivery time the buyer is offering
 * justifies moving price beyond the merchant's ordinary per-round
 * concession — and if so, how far. Deliberately NOT a universal
 * "+X days -> -Y rupees" rule: the SAME extension produces a different
 * verdict depending on the merchant's own stock pressure
 * (resolveMerchantStockPressure) — the inverse asymmetry from
 * merchantTradeEvaluator.ts's own quantity logic, see the module comment.
 *
 * - Price already below the floor: REJECT outright, regardless of how
 *   much extra time is offered — no amount of delivery slack makes an
 *   unprofitable price attractive.
 * - No meaningful extension (extraDays <= 0): HOLD at baseline — nothing
 *   for this function to evaluate (defensive; callers only invoke this
 *   on a genuine round-over-round increase, so this should not occur in
 *   practice).
 * - Abundant stock (stock pressure "high"): HOLD at baseline — the
 *   merchant could already ship on schedule, so the extra time has no
 *   real operational value to reward. Still a real evaluation, not a
 *   refusal: the delivery date itself is unaffected (see
 *   applyMerchantConcession, which always honors resolveDeliveryTrade's
 *   own clamped date regardless of this verdict) — only the PRICE
 *   benefit is withheld.
 * - Constrained or medium stock: computes a stock-weighted discount off
 *   the baseline (the same per-day rate resolveDeliveryTrade already
 *   uses at its "medium" tier, boosted for genuinely constrained stock).
 *   If that discount is generous enough to already clear the buyer's own
 *   ask, ACCEPT at the buyer's price (still floor-clamped). Otherwise
 *   COUNTER at the discounted price.
 */
export function evaluateMerchantDeliveryTrade(
  item: Pick<CatalogItemSnapshot, "minPrice" | "listedPrice" | "availableQty">,
  proposal: MerchantDeliveryTradeProposal,
  context: MerchantDeliveryTradeContext,
): MerchantDeliveryTradeEvaluation {
  const floor = item.minPrice;
  const baseline = clamp(context.baselineConcessionPrice, floor, item.listedPrice);

  if (proposal.unitPrice < floor) {
    return {
      verdict: "REJECT",
      unitPrice: baseline,
      reason: "The proposed price is below our minimum acceptable price, regardless of the delivery window offered.",
    };
  }

  if (proposal.extraDays <= 0) {
    return {
      verdict: "HOLD",
      unitPrice: baseline,
      reason: "No meaningful delivery extension was actually offered.",
    };
  }

  const stockPressure = resolveMerchantStockPressure(item);
  const multiplier =
    stockPressure === "low"
      ? CONSTRAINED_STOCK_DELIVERY_TRADE_MULTIPLIER
      : stockPressure === "high"
        ? ABUNDANT_STOCK_DELIVERY_TRADE_MULTIPLIER
        : 1.0;

  if (multiplier <= 0) {
    return {
      verdict: "HOLD",
      unitPrice: baseline,
      reason: "Stock is abundant enough that the extra delivery time offered has no real operational value to reward with a lower price.",
    };
  }

  const discountFraction =
    Math.min(proposal.extraDays * DELIVERY_TRADE_DISCOUNT_PER_DAY_FRACTION, MAX_DELIVERY_TRADE_DISCOUNT_FRACTION) *
    multiplier;
  const margin = item.listedPrice - floor;
  const tradedPrice = clamp(Math.round(baseline - margin * discountFraction), floor, item.listedPrice);

  if (tradedPrice <= proposal.unitPrice) {
    return {
      verdict: "ACCEPT",
      unitPrice: clamp(Math.round(proposal.unitPrice), floor, item.listedPrice),
      reason: "The delivery window offered is valuable given our current stock position; we can meet your price.",
    };
  }

  return {
    verdict: "COUNTER",
    unitPrice: tradedPrice,
    reason:
      stockPressure === "low"
        ? "Stock is limited, so the extra delivery time offered is genuinely valuable and justifies a real discount."
        : "The extra delivery time offered justifies a modest discount.",
  };
}
