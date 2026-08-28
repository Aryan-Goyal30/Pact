// Merchant combined quantity+delivery-for-price trade evaluator — PACT
// V2 Milestone 12.
//
// Evaluates the buyer's combined package (buyerQuantityAndDeliveryTrade.ts)
// as ONE economic proposal — not by calling evaluateMerchantTrade() and
// evaluateMerchantDeliveryTrade() independently and mechanically
// stacking their two separate resulting prices, which would either
// double-discount off two DIFFERENT blind baselines or have no coherent
// way to combine two independent verdicts at all.
//
// Deliberately its own module, mirroring merchantDeliveryTradeEvaluator.ts's
// own precedent exactly: shares the CONVENTION (ACCEPT/COUNTER/HOLD/REJECT
// verdict + unitPrice + reason) with the two solo evaluators, never their
// implementation, and never touches either of them.
//
// Key finding this module's design rests on (Milestone 12 design
// review, section F): quantity and delivery have DELIBERATELY OPPOSITE
// stock-pressure directionality. evaluateMerchantTrade rewards abundant
// stock and withholds any discount at scarce stock; evaluateMerchantDeliveryTrade
// rewards scarce stock and withholds any discount at abundant stock —
// "the inverse asymmetry from the quantity evaluator's own stock-pressure
// signal," per that module's own comment. This means at any given stock
// level, AT MOST ONE of the two dimensions genuinely contributes value —
// the formulas were already built to avoid double-counting a joint
// discount, they just never previously talked to each other. Summing
// their two discount FRACTIONS (never their two prices) off ONE shared,
// genuinely joint-blind baseline is therefore not "adding two big
// numbers" in practice — only at "medium" stock (where neither formula
// is at an extreme) do both terms contribute at once, and even then each
// is individually modest (each side's own existing no-op-adjacent zone).
//
// This is a CALIBRATION STARTING POINT (see the module's own constants
// below, and merchantPackageTradeEvaluator.calibration.test.ts for the
// empirical probe across abundant/medium/scarce stock this milestone's
// own discipline required before trusting it) — not an assumption that
// package economics are always additive in general.

import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import {
  ABUNDANT_STOCK_DELIVERY_TRADE_MULTIPLIER,
  CONSTRAINED_STOCK_DELIVERY_TRADE_MULTIPLIER,
  DELIVERY_TRADE_DISCOUNT_PER_DAY_FRACTION,
  LARGE_ORDER_MERCHANT_DISCOUNT,
  MAX_DELIVERY_TRADE_DISCOUNT_FRACTION,
  resolveMerchantStockPressure,
} from "@/lib/rules/negotiationStrategy";
import { ABUNDANT_STOCK_TRADE_MULTIPLIER } from "@/lib/rules/merchantTradeEvaluator";

export type MerchantPackageTradeVerdict = "ACCEPT" | "COUNTER" | "HOLD" | "REJECT";

/** The combined quantity+delivery <-> price trade being evaluated. */
export interface MerchantPackageTradeProposal {
  quantity: number;
  /** Already clamped to the merchant's own maxDeliveryDays by the caller (resolveDeliveryTrade) — never re-derived here, mirroring merchantDeliveryTradeEvaluator.ts's own convention. */
  extraDays: number;
  unitPrice: number;
}

export interface MerchantPackageTradeContext {
  /**
   * What the merchant's ordinary round-aware concession price would be
   * this round, GENUINELY blind to BOTH the quantity and delivery
   * dimensions — i.e. computeMerchantConcessionPrice's output with
   * NEITHER requestedQuantity NOR deliveryTradeDiscount in its context
   * (stock-pressure speed factor and reciprocity still apply). Neither
   * solo evaluator's own "blind" baseline excludes both factors at
   * once — this is the one genuinely new computation this milestone
   * introduces, and it's a config-only call to the existing, unchanged
   * computeMerchantConcessionPrice.
   */
  jointBlindBaselinePrice: number;
}

export interface MerchantPackageTradeEvaluation {
  verdict: MerchantPackageTradeVerdict;
  /** The unit price the merchant is willing to offer given this verdict. Always clamped to [item.minPrice, item.listedPrice]. */
  unitPrice: number;
  /** Human-readable explanation — feeds NegotiationResult.reasons, which the LLM phrases. Never contains a number the LLM shouldn't already have. */
  reason: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The quantity dimension's own discount FRACTION at this stock level —
 * reuses evaluateMerchantTrade's exact formula/constants (LARGE_ORDER_MERCHANT_DISCOUNT,
 * ABUNDANT_STOCK_TRADE_MULTIPLIER), never re-derived or re-tuned: scarce
 * stock contributes NOTHING (mirrors that evaluator's own HOLD-at-low-stock
 * verdict — inventory is too valuable to discount for volume), medium
 * stock contributes the flat rate, abundant stock contributes the
 * boosted rate.
 */
function quantityDiscountFraction(stockPressure: "low" | "medium" | "high"): number {
  if (stockPressure === "low") return 0;
  return stockPressure === "high" ? LARGE_ORDER_MERCHANT_DISCOUNT * ABUNDANT_STOCK_TRADE_MULTIPLIER : LARGE_ORDER_MERCHANT_DISCOUNT;
}

/**
 * The delivery dimension's own discount FRACTION at this stock level —
 * reuses evaluateMerchantDeliveryTrade's exact formula/constants
 * (DELIVERY_TRADE_DISCOUNT_PER_DAY_FRACTION, MAX_DELIVERY_TRADE_DISCOUNT_FRACTION,
 * CONSTRAINED_STOCK_DELIVERY_TRADE_MULTIPLIER, ABUNDANT_STOCK_DELIVERY_TRADE_MULTIPLIER),
 * never re-derived: abundant stock contributes NOTHING (the merchant
 * could already ship on schedule, extra time has no operational value),
 * scarce stock contributes the boosted rate, medium stock the flat rate.
 */
function deliveryDiscountFraction(stockPressure: "low" | "medium" | "high", extraDays: number): number {
  const multiplier =
    stockPressure === "low"
      ? CONSTRAINED_STOCK_DELIVERY_TRADE_MULTIPLIER
      : stockPressure === "high"
        ? ABUNDANT_STOCK_DELIVERY_TRADE_MULTIPLIER
        : 1.0;
  if (multiplier <= 0) return 0;
  return Math.min(extraDays * DELIVERY_TRADE_DISCOUNT_PER_DAY_FRACTION, MAX_DELIVERY_TRADE_DISCOUNT_FRACTION) * multiplier;
}

/**
 * Evaluates the buyer's combined quantity+delivery package as ONE
 * economic proposal. Deliberately NOT a call-and-stack of the two solo
 * evaluators — see this module's own header comment for why summing
 * their discount FRACTIONS off one shared joint-blind baseline is the
 * calibration starting point, not a call to either function.
 *
 * Callers (generateMerchantCandidates) are expected to only invoke this
 * when BOTH dimensions genuinely increased in THIS SAME round (a
 * deliberate, joint move — see buyerQuantityAndDeliveryTrade.ts) — this
 * function itself does not re-derive "was this genuine," mirroring
 * evaluateMerchantDeliveryTrade's own reliance on its caller for that
 * signal.
 *
 * - Price already below the floor: REJECT outright, regardless of the
 *   package offered — no combination of quantity/delivery makes an
 *   unprofitable price attractive.
 * - No meaningful package (quantity <= 0 or extraDays <= 0): HOLD at
 *   baseline — defensive; callers should not reach this in practice.
 * - Otherwise: sums the two dimensions' own discount fractions (each
 *   computed exactly as their solo evaluators would, at this item's
 *   real stock pressure) against the ONE joint-blind baseline. If that
 *   combined discount already clears the buyer's own ask, ACCEPT at the
 *   buyer's price (floor-clamped). Otherwise COUNTER at the
 *   combined-discounted price.
 */
export function evaluateMerchantPackageTrade(
  item: Pick<CatalogItemSnapshot, "minPrice" | "listedPrice" | "availableQty">,
  proposal: MerchantPackageTradeProposal,
  context: MerchantPackageTradeContext,
): MerchantPackageTradeEvaluation {
  const floor = item.minPrice;
  const baseline = clamp(context.jointBlindBaselinePrice, floor, item.listedPrice);

  if (proposal.unitPrice < floor) {
    return {
      verdict: "REJECT",
      unitPrice: baseline,
      reason: "The proposed price is below our minimum acceptable price, regardless of the package offered.",
    };
  }

  if (proposal.quantity <= 0 || proposal.extraDays <= 0) {
    return {
      verdict: "HOLD",
      unitPrice: baseline,
      reason: "No meaningful combined package was actually offered.",
    };
  }

  const stockPressure = resolveMerchantStockPressure(item);
  const quantityFraction = quantityDiscountFraction(stockPressure);
  const deliveryFraction = deliveryDiscountFraction(stockPressure, proposal.extraDays);
  const combinedFraction = quantityFraction + deliveryFraction;

  if (combinedFraction <= 0) {
    return {
      verdict: "HOLD",
      unitPrice: baseline,
      reason: "Neither the extra quantity nor the extra delivery time offered has real value to us at our current stock position.",
    };
  }

  const margin = item.listedPrice - floor;
  const tradedPrice = clamp(Math.round(baseline - margin * combinedFraction), floor, item.listedPrice);

  if (tradedPrice <= proposal.unitPrice) {
    return {
      verdict: "ACCEPT",
      unitPrice: clamp(Math.round(proposal.unitPrice), floor, item.listedPrice),
      reason: "The combined order size and delivery window offered are attractive given our current stock position; we can meet your price.",
    };
  }

  return {
    verdict: "COUNTER",
    unitPrice: tradedPrice,
    reason:
      quantityFraction > 0 && deliveryFraction > 0
        ? "Both the extra order size and the extra delivery time offered are valuable given our current stock position, justifying a real combined discount."
        : quantityFraction > 0
          ? "The order size is what makes this package attractive given our current stock position; the delivery window offered has little additional value right now."
          : "The delivery window offered is what makes this package attractive given our current stock position; the extra order size has little additional value right now.",
  };
}
