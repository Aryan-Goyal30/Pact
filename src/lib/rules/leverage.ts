// Live buyer-vs-merchant leverage score — negotiation strategy milestone.
//
// Pure and synchronous, same discipline as negotiationStrategy.ts, which
// this module reuses rather than duplicates: every signal here is
// derived from the SAME deterministic factors already driving the real
// price/quantity/delivery math (resolveMerchantStockPressure,
// hasQuantityLeverage, resolveUrgencyConcessionFactor's categories,
// resolveDeliveryTrade's own flexibility gate) plus two new but simple,
// transparent ratios (fulfillability, price position). Nothing here
// feeds back into the negotiation engine — this only EXPLAINS the state
// the engine already produced.
//
// Server-side only: item.minPrice is a required input (the price-
// position component needs the full [minPrice, listedPrice] band to
// normalize against), so this must never be called from client code.
// Only its OUTPUT (0-100 numbers + human-readable reasons — no price
// bounds, no minPrice) is safe to send to the browser, exactly the same
// public/private boundary negotiationEngine.ts's NegotiationResult
// already draws.

import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import {
  LARGE_ORDER_QUANTITY_THRESHOLD,
  resolveDeliveryTrade,
  resolveMerchantStockPressure,
  resolveUrgencyConcessionFactor,
} from "@/lib/rules/negotiationStrategy";

export interface LeverageScore {
  /** 0-100. Always buyerLeverage + merchantLeverage === 100. */
  buyerLeverage: number;
  merchantLeverage: number;
  /** Up to 3 short, human-readable explanations of the dominant factors — never derived from or shown to the LLM. */
  reasons: string[];
}

export interface LeverageInput {
  item: Pick<
    CatalogItemSnapshot,
    "availableQty" | "listedPrice" | "minPrice" | "standardDeliveryDays" | "maxDeliveryDays"
  >;
  buyerConstraints: Pick<
    BuyerConstraints,
    "quantity" | "deliveryDeadlineDays" | "urgency" | "deliveryFlexible"
  >;
  /** The merchant's current unit-price offer this round, if one exists yet (null for a rejected/no-offer state). */
  currentMerchantUnitPrice: number | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const REASON_THRESHOLD = 0.1;

/**
 * Stock pressure: abundant stock relative to the merchant's general
 * posture favors the buyer (the merchant is more willing to move);
 * scarce stock favors the merchant. Reuses
 * negotiationStrategy.resolveMerchantStockPressure exactly — the same
 * signal computeMerchantConcessionPrice's speed factor is built on.
 */
function stockComponent(item: LeverageInput["item"]): number {
  const pressure = resolveMerchantStockPressure(item);
  if (pressure === "high") return 0.35;
  if (pressure === "low") return -0.35;
  return 0;
}

/**
 * Fulfillability: how the requested quantity compares to what's
 * actually in stock. Requesting more than is available shifts leverage
 * to the merchant (it physically cannot fill the order, and the
 * existing partial-fulfillment rule already governs what it offers
 * instead); requesting comfortably less leaves room for buyer leverage.
 * This is the one component that makes "large quantity + low stock"
 * (item J) resolve correctly without any special-case: the two
 * quantity-driven components below simply pull in opposite directions.
 */
function fulfillabilityComponent(item: LeverageInput["item"], quantity: number): number {
  if (item.availableQty <= 0) return -0.5;
  const ratio = (item.availableQty - quantity) / item.availableQty;
  return clamp(ratio, -1, 1) * 0.4;
}

/**
 * Bulk-order leverage: reuses negotiationStrategy.hasQuantityLeverage's
 * own threshold, smoothed into a ramp instead of a hard step so the
 * graph moves gradually as an order approaches "large."
 */
function quantityLeverageComponent(quantity: number): number {
  return clamp(quantity / LARGE_ORDER_QUANTITY_THRESHOLD, 0, 1) * 0.3;
}

/**
 * Urgency: reuses resolveUrgencyConcessionFactor's own categories.
 * High urgency (the buyer needs this fast) hands the merchant leverage;
 * low urgency (the buyer can wait) hands the buyer leverage.
 */
function urgencyComponent(urgency: BuyerConstraints["urgency"]): number {
  const factor = resolveUrgencyConcessionFactor(urgency);
  // factor is 0.65 (low) / 1.0 (medium) / 1.4 (high) — center on medium
  // and flip sign, since high urgency favors the MERCHANT.
  return clamp((1 - factor) / 0.4, -1, 1) * 0.3;
}

/**
 * Delivery flexibility: reuses resolveDeliveryTrade's own gating (real
 * slack AND the buyer opted in) rather than re-deriving it — a buyer who
 * merely has slack but hasn't signaled flexibility gains no leverage
 * from it, same as the price math itself.
 */
function deliveryFlexComponent(
  item: LeverageInput["item"],
  buyerConstraints: LeverageInput["buyerConstraints"],
): number {
  const trade = resolveDeliveryTrade(
    item,
    buyerConstraints.deliveryDeadlineDays,
    buyerConstraints.deliveryFlexible ?? false,
  );
  return trade.traded ? 0.3 : 0;
}

/**
 * Price position: the one DYNAMIC component, recomputed every round —
 * where the merchant's current offer sits within [minPrice, listedPrice].
 * Close to listedPrice: the buyer hasn't extracted anything yet
 * (merchant-favoring). Close to minPrice: the buyer has extracted
 * (almost) everything possible (buyer-favoring). This is what makes the
 * graph visibly move round to round even when every structural input
 * (quantity, stock, urgency, flexibility) stays fixed for the whole
 * session.
 */
function pricePositionComponent(
  item: LeverageInput["item"],
  currentMerchantUnitPrice: number | null,
): number {
  if (currentMerchantUnitPrice === null || item.listedPrice <= item.minPrice) {
    return 0;
  }
  const fraction =
    (item.listedPrice - currentMerchantUnitPrice) / (item.listedPrice - item.minPrice);
  return (clamp(fraction, 0, 1) - 0.5) * 0.6;
}

/**
 * Computes a live 0-100 buyer-vs-merchant leverage score from the same
 * deterministic strategic factors already driving the real negotiation
 * math — never from Gemini, never from anything the LLM produced. See
 * each component function above for what it measures and why.
 */
export function computeLeverage(input: LeverageInput): LeverageScore {
  const components: Array<{ value: number; positive: string; negative: string }> = [
    {
      value: stockComponent(input.item),
      positive: "Buyer leverage increased due to the merchant's ample stock.",
      negative: "Merchant leverage increased due to limited stock.",
    },
    {
      value: fulfillabilityComponent(input.item, input.buyerConstraints.quantity),
      positive: "Buyer leverage increased — the order comfortably fits within available stock.",
      negative: "Merchant leverage increased because the requested quantity exceeds available stock.",
    },
    {
      value: quantityLeverageComponent(input.buyerConstraints.quantity),
      positive: "Buyer leverage increased due to the large order quantity.",
      negative: "",
    },
    {
      value: urgencyComponent(input.buyerConstraints.urgency),
      positive: "Buyer leverage increased due to low urgency, allowing patience.",
      negative: "Merchant leverage increased due to the buyer's urgent delivery need.",
    },
    {
      value: deliveryFlexComponent(input.item, input.buyerConstraints),
      positive: "Buyer leverage increased due to delivery flexibility.",
      negative: "",
    },
    {
      value: pricePositionComponent(input.item, input.currentMerchantUnitPrice),
      positive: "Buyer leverage increased as the price has moved closer to the buyer's side.",
      negative: "Merchant leverage increased as the price remains close to the listed price.",
    },
  ];

  const total = clamp(
    components.reduce((sum, c) => sum + c.value, 0),
    -1,
    1,
  );
  const buyerLeverage = Math.round(clamp(50 + total * 50, 0, 100));
  const merchantLeverage = 100 - buyerLeverage;

  const reasons = components
    .filter((c) => Math.abs(c.value) >= REASON_THRESHOLD)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .map((c) => (c.value > 0 ? c.positive : c.negative))
    .filter((reason) => reason.length > 0)
    .slice(0, 3);

  return { buyerLeverage, merchantLeverage, reasons };
}
