// Merchant conditional trade evaluator — PACT V2 Milestone 1.
//
// The first piece of "real bargaining" rather than pure price
// convergence: instead of a single price nudged toward the buyer's
// number by a fixed formula, the merchant now asks "is the DEAL the
// buyer is implicitly proposing (this quantity, at roughly this price)
// actually worth it, given my own state?" before deciding how far to
// move. Quantity <-> price is the one trade dimension this milestone
// implements; delivery/partial-fulfillment trades remain future work
// (see the architecture-review conversation this milestone follows).
//
// Deliberately does NOT touch computeMerchantConcessionPrice
// (negotiationEngine.ts) or its own requestedQuantity/hasQuantityLeverage
// branch — that function and its existing tests are left completely
// intact. This module is consulted ADDITIONALLY, by merchantAgent.ts,
// which now computes the quantity-blind baseline price via the existing
// function and hands it here to decide whether (and how much) a
// quantity-driven adjustment on top of that baseline is actually
// justified. Nothing here decides quantity or delivery — only whether,
// and how far, to move PRICE in response to the quantity being asked
// for. The final [minPrice, listedPrice] clamp is enforced here too, so
// this can never produce a price outside the merchant's authoritative
// bounds no matter what verdict it reaches.

import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import {
  hasQuantityLeverage,
  resolveMerchantStockPressure,
  LARGE_ORDER_MERCHANT_DISCOUNT,
} from "@/lib/rules/negotiationStrategy";

export type MerchantTradeVerdict = "ACCEPT" | "COUNTER" | "HOLD" | "REJECT";

/** The quantity <-> price trade being evaluated: the buyer's requested quantity and the price it's asking for. */
export interface MerchantTradeProposal {
  quantity: number;
  unitPrice: number;
}

export interface MerchantTradeContext {
  /**
   * What the merchant's ordinary, quantity-blind round-aware concession
   * price would be this round — i.e. computeMerchantConcessionPrice's
   * output WITHOUT a requestedQuantity in its context (stock-pressure
   * speed factor and any delivery trade still apply; only the
   * quantity-driven adjustment is excluded, since that's what this
   * function decides instead). This is both the comparison baseline and
   * the fallback price for HOLD/REJECT/below-threshold verdicts.
   */
  baselineConcessionPrice: number;
  /**
   * Milestone 5: true when the buyer's quantity genuinely increased from
   * its own prior round — even if the absolute quantity itself stays
   * below LARGE_ORDER_QUANTITY_THRESHOLD (hasQuantityLeverage). Widens
   * ONLY the entry gate immediately below: every other part of this
   * function's verdict (the stock-pressure discount size, the floor
   * rejection, the ACCEPT threshold) is completely unchanged. Omitted
   * (or false) reproduces exactly today's (pre-Milestone-5) behavior —
   * only the flat bulk-order threshold can unlock a discount.
   */
  hasGenuineIncrease?: boolean;
}

export interface MerchantTradeEvaluation {
  verdict: MerchantTradeVerdict;
  /** The unit price the merchant is willing to offer given this verdict. Always clamped to [item.minPrice, item.listedPrice]. */
  unitPrice: number;
  /** Human-readable explanation of the verdict — feeds NegotiationResult.reasons, which the LLM phrases (see merchantAgent.ts's toPublicContext). Never contains a number the LLM shouldn't already have. */
  reason: string;
}

/**
 * How much more generous the quantity-driven discount is when stock is
 * abundant, relative to LARGE_ORDER_MERCHANT_DISCOUNT (the existing
 * flat 4% used at "medium" stock pressure — kept identical here so
 * every currently-passing medium-stock test is unaffected regardless of
 * whether it goes through this function or the old flat branch).
 */
// Exported (Milestone 12) so merchantPackageTradeEvaluator.ts can reuse
// this exact, already-calibrated multiplier for the combined
// quantity+delivery package's own quantity term — never a duplicated or
// re-derived value. This is the one unavoidable touch to this file the
// Milestone 12 design review anticipated ("unless a concrete integration
// issue requires a minimal adjustment"): the constant itself, and every
// other line in this file, are completely unchanged.
export const ABUNDANT_STOCK_TRADE_MULTIPLIER = 1.75;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Evaluates whether the quantity the buyer is asking for justifies
 * moving price beyond the merchant's ordinary per-round concession —
 * and if so, how far. Deliberately NOT "more quantity always means
 * lower price": the same large order produces a different verdict
 * depending on the merchant's own stock pressure (resolveMerchantStockPressure),
 * exactly the scarce-vs-abundant asymmetry the product review called for.
 *
 * - Price already below the floor: REJECT outright, regardless of
 *   quantity — no order size makes an unprofitable price attractive.
 * - Quantity doesn't cross the bulk-order threshold (hasQuantityLeverage):
 *   COUNTER at the plain baseline — nothing for this function to add.
 * - Scarce stock (stock pressure "low"): HOLD at the baseline — the
 *   order is large, but inventory is too valuable to discount for
 *   volume right now (Scenario B from the product review).
 * - Abundant or medium stock: computes a stock-weighted discount off the
 *   baseline. If that discount is generous enough to already clear the
 *   buyer's own ask, ACCEPT at the buyer's price (still floor-clamped).
 *   Otherwise COUNTER at the discounted price — genuinely better than
 *   the baseline, but not a full concession.
 */
export function evaluateMerchantTrade(
  item: Pick<CatalogItemSnapshot, "minPrice" | "listedPrice" | "availableQty">,
  proposal: MerchantTradeProposal,
  context: MerchantTradeContext,
): MerchantTradeEvaluation {
  const floor = item.minPrice;
  const baseline = clamp(context.baselineConcessionPrice, floor, item.listedPrice);

  if (proposal.unitPrice < floor) {
    return {
      verdict: "REJECT",
      unitPrice: baseline,
      reason: "The proposed price is below our minimum acceptable price, regardless of order size.",
    };
  }

  if (!hasQuantityLeverage(proposal.quantity) && !context.hasGenuineIncrease) {
    return {
      verdict: "COUNTER",
      unitPrice: baseline,
      reason: "Standard round-by-round pricing; the requested quantity is not large enough to change it.",
    };
  }

  const stockPressure = resolveMerchantStockPressure(item);

  if (stockPressure === "low") {
    return {
      verdict: "HOLD",
      unitPrice: baseline,
      reason: "Inventory is limited, so the larger order does not currently justify an additional discount.",
    };
  }

  const margin = item.listedPrice - floor;
  const bonusFraction =
    stockPressure === "high"
      ? LARGE_ORDER_MERCHANT_DISCOUNT * ABUNDANT_STOCK_TRADE_MULTIPLIER
      : LARGE_ORDER_MERCHANT_DISCOUNT;
  const tradedPrice = clamp(Math.round(baseline - margin * bonusFraction), floor, item.listedPrice);

  if (tradedPrice <= proposal.unitPrice) {
    return {
      verdict: "ACCEPT",
      unitPrice: clamp(Math.round(proposal.unitPrice), floor, item.listedPrice),
      reason: "The order size makes this quantity attractive given available stock; we can meet your price.",
    };
  }

  return {
    verdict: "COUNTER",
    unitPrice: tradedPrice,
    reason:
      stockPressure === "high"
        ? "The order size and available stock justify an additional discount for this quantity."
        : "The order size justifies a modest additional discount for this quantity.",
  };
}
