// Deterministic catalog/fulfillment rules. No LLM involved anywhere in
// this file — every function here is a pure, synchronous, unit-testable
// calculation over plain numbers. This is the "deterministic code
// disposes" half of PACT's negotiation architecture: a future LLM-driven
// agent may *propose* a quantity/price/delivery combination, but only the
// functions in this file decide whether that proposal is actually valid.

/** The subset of CatalogItem fields the rule engine needs. */
export interface CatalogItemSnapshot {
  sku: string;
  listedPrice: number;
  minPrice: number;
  availableQty: number;
  standardDeliveryDays: number;
  maxDeliveryDays: number;
  negotiationEnabled: boolean;
}

/** A buyer's structured request for a single catalog item. */
export interface FulfillmentRequest {
  quantity: number;
  /** Buyer's price ceiling per unit. Omit if the buyer stated no budget constraint. */
  maxPricePerUnit?: number;
  /** Buyer's delivery deadline in days. Omit if the buyer stated no deadline. */
  deliveryDeadlineDays?: number;
}

export interface QuantityCheckResult {
  requestedQuantity: number;
  availableQuantity: number;
  /** min(requestedQuantity, availableQuantity), floored at 0. */
  fulfillableQuantity: number;
  isFullyAvailable: boolean;
}

export interface DeliveryCheckResult {
  requestedDeliveryDays?: number;
  /** The delivery time the merchant would actually offer (its standard lead time). */
  offeredDeliveryDays: number;
  isAchievable: boolean;
}

export interface PriceFloorCheckResult {
  requestedPricePerUnit: number;
  isAtOrAboveFloor: boolean;
}

export type FulfillmentKind =
  | "exact_fulfillment"
  | "partial_fulfillment"
  | "price_adjustment_required"
  | "impossible";

export interface FulfillmentOutcome {
  kind: FulfillmentKind;
  sku: string;
  /** null when kind is "impossible". */
  offeredQuantity: number | null;
  offeredPricePerUnit: number | null;
  offeredDeliveryDays: number | null;
  /** Human-readable reasons a future LLM layer can turn into negotiation text. */
  reasons: string[];
}

/** Checks whether the requested quantity is available in stock. */
export function checkQuantityAvailable(
  item: CatalogItemSnapshot,
  requestedQuantity: number,
): QuantityCheckResult {
  const fulfillableQuantity = Math.max(
    0,
    Math.min(requestedQuantity, item.availableQty),
  );

  return {
    requestedQuantity,
    availableQuantity: item.availableQty,
    fulfillableQuantity,
    isFullyAvailable: item.availableQty >= requestedQuantity,
  };
}

/**
 * Checks whether a requested delivery deadline is achievable.
 * standardDeliveryDays is the merchant's normal, no-extra-cost lead
 * time — a looser deadline than that still gets the standard pace
 * (going slower than asked has never been meaningful; only extending
 * further via maxDeliveryDays, elsewhere, is).
 *
 * Scenario-behavior fix: a deadline FASTER than standard used to be an
 * unconditional hard-reject of the entire request — there was no way to
 * ever negotiate rush delivery at all, which is why "urgent delivery"
 * demo scenarios could only ever set a deadline equal to standard (zero
 * real urgency to negotiate). A real merchant can typically expedite a
 * shipment for a premium; that premium is priced by the caller (see
 * resolveDeliveryRushPremiumFraction, negotiationStrategy.ts) — this
 * function's job is only to report that it CAN be met (isAchievable),
 * and that the merchant's offer, when it can, genuinely meets the
 * buyer's own faster date rather than silently reverting to the
 * standard one. The only remaining non-achievable case is a nonsensical
 * (non-positive) deadline, unrelated to price.
 */
export function checkDeliveryAchievable(
  item: CatalogItemSnapshot,
  requestedDeliveryDays?: number,
): DeliveryCheckResult {
  const isAchievable = requestedDeliveryDays === undefined || requestedDeliveryDays >= 1;
  const offeredDeliveryDays =
    requestedDeliveryDays !== undefined && requestedDeliveryDays < item.standardDeliveryDays
      ? requestedDeliveryDays
      : item.standardDeliveryDays;

  return {
    requestedDeliveryDays,
    offeredDeliveryDays,
    isAchievable,
  };
}

/** Checks whether a requested price per unit is at or above the merchant's private price floor. */
export function checkPriceAtOrAboveFloor(
  item: CatalogItemSnapshot,
  requestedPricePerUnit: number,
): PriceFloorCheckResult {
  return {
    requestedPricePerUnit,
    isAtOrAboveFloor: requestedPricePerUnit >= item.minPrice,
  };
}

/**
 * Classifies a buyer's request against a catalog item into one of four
 * outcomes:
 *
 *  - exact_fulfillment: the request can be met exactly as asked
 *  - partial_fulfillment: stock is short; a smaller quantity can be offered
 *  - price_adjustment_required: quantity/delivery are fine, but the
 *    buyer's price ceiling is below listed price (though still at or
 *    above the merchant's floor)
 *  - impossible: no combination of quantity/price/delivery within this
 *    item's rules can satisfy the request
 *
 * When more than one axis needs adjustment, quantity takes priority in
 * `kind` (it is the harder physical constraint), but every adjustment is
 * still listed in `reasons`.
 */
export function evaluateFulfillment(
  item: CatalogItemSnapshot,
  request: FulfillmentRequest,
): FulfillmentOutcome {
  const impossible = (reasons: string[]): FulfillmentOutcome => ({
    kind: "impossible",
    sku: item.sku,
    offeredQuantity: null,
    offeredPricePerUnit: null,
    offeredDeliveryDays: null,
    reasons,
  });

  if (item.availableQty <= 0) {
    return impossible(["Item is out of stock."]);
  }

  const quantityCheck = checkQuantityAvailable(item, request.quantity);
  const deliveryCheck = checkDeliveryAchievable(
    item,
    request.deliveryDeadlineDays,
  );

  let priceFit: "full" | "adjustable" | "impossible" = "full";
  let offeredPricePerUnit = item.listedPrice;

  if (request.maxPricePerUnit !== undefined) {
    if (request.maxPricePerUnit >= item.listedPrice) {
      priceFit = "full";
      offeredPricePerUnit = item.listedPrice;
    } else if (checkPriceAtOrAboveFloor(item, request.maxPricePerUnit).isAtOrAboveFloor) {
      priceFit = "adjustable";
      offeredPricePerUnit = request.maxPricePerUnit;
    } else {
      priceFit = "impossible";
    }
  }

  const impossibleReasons: string[] = [];
  if (!deliveryCheck.isAchievable) {
    impossibleReasons.push(
      `Requested delivery in ${request.deliveryDeadlineDays} day(s) is faster than the standard ${item.standardDeliveryDays} day(s).`,
    );
  }
  if (priceFit === "impossible") {
    impossibleReasons.push(
      "Requested price is below the merchant's acceptable range.",
    );
  }
  if (impossibleReasons.length > 0) {
    return impossible(impossibleReasons);
  }

  const needsQuantityAdjustment = !quantityCheck.isFullyAvailable;
  const needsPriceAdjustment = priceFit === "adjustable";

  if (!item.negotiationEnabled && (needsQuantityAdjustment || needsPriceAdjustment)) {
    return impossible([
      "This item is not open to negotiation; only exact listed terms can be fulfilled.",
    ]);
  }

  const reasons: string[] = [];
  if (needsQuantityAdjustment) {
    reasons.push(
      `Only ${quantityCheck.availableQuantity} unit(s) available; requested ${quantityCheck.requestedQuantity}.`,
    );
  }
  if (needsPriceAdjustment) {
    reasons.push(
      `Adjusted price of ${offeredPricePerUnit} offered instead of listed ${item.listedPrice}.`,
    );
  }

  const kind: FulfillmentKind = needsQuantityAdjustment
    ? "partial_fulfillment"
    : needsPriceAdjustment
      ? "price_adjustment_required"
      : "exact_fulfillment";

  return {
    kind,
    sku: item.sku,
    offeredQuantity: quantityCheck.fulfillableQuantity,
    offeredPricePerUnit,
    offeredDeliveryDays: deliveryCheck.offeredDeliveryDays,
    reasons,
  };
}
