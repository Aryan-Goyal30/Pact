// The deterministic negotiation engine — Phase 3.
//
// This is the piece the future LLM agents propose to and never override.
// Every exported function here is pure and synchronous: given a catalog
// item snapshot and a structured request, it returns a structured result.
// No network calls, no randomness, no LLM. See negotiationState.ts for
// the separate round-limit/status state machine, and
// negotiationRepository.ts for the one DB-touching wrapper.

import {
  checkDeliveryAchievable,
  checkQuantityAvailable,
  type CatalogItemSnapshot,
} from "@/lib/rules/catalogRules";

/** A buyer agent's normalized, structured request for one SKU. */
export interface NegotiationRequest {
  sku: string;
  quantity: number;
  /** Buyer's price ceiling per unit. Omit if the buyer stated no budget constraint. */
  maxUnitPrice?: number;
  /** Buyer's delivery deadline in days. Omit if the buyer stated no deadline. */
  deliveryDeadlineDays?: number;
  /**
   * Free-text buyer preference/context (e.g. "prefers faster delivery over
   * a lower price"). Carried through for a future LLM layer to read when
   * phrasing a response — the deterministic engine never reads this
   * field to make a decision.
   */
  buyerContext?: string;
}

export type NegotiationOutcome =
  | "EXACT_MATCH"
  | "COUNTER_OFFER"
  | "PARTIAL_FULFILLMENT"
  | "REJECTED";

export interface NegotiationResult {
  outcome: NegotiationOutcome;
  sku: string;
  requestedQuantity: number;
  /** null only when outcome is REJECTED. */
  offeredQuantity: number | null;
  /** null only when outcome is REJECTED. */
  unitPrice: number | null;
  /** null only when outcome is REJECTED. */
  deliveryDays: number | null;
  reasons: string[];
}

function rejected(
  sku: string,
  requestedQuantity: number,
  reasons: string[],
): NegotiationResult {
  return {
    outcome: "REJECTED",
    sku,
    requestedQuantity,
    offeredQuantity: null,
    unitPrice: null,
    deliveryDays: null,
    reasons,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Counter-offer pricing strategy: "anchored midpoint".
 *
 * Rather than immediately conceding all the way down to the buyer's
 * stated ceiling, the merchant's opening counter is the midpoint between
 * its listed price and the buyer's ceiling — a standard "split the
 * difference" opening move. The result is then clamped to
 * [minPrice, listedPrice], so:
 *
 *  - it can never land below the merchant's private floor, even if the
 *    buyer's ceiling is far below the floor (the clamp pulls it back up
 *    to minPrice, which becomes the merchant's best possible offer), and
 *  - it never exceeds the listed price (this function is only called
 *    once we already know the buyer's ceiling is below listed price).
 *
 * This is one deterministic, documented strategy — not the buyer's
 * number, not a hard-coded demo value.
 */
export function computeCounterOfferPrice(
  item: CatalogItemSnapshot,
  buyerMaxUnitPrice: number,
): number {
  const midpoint = (item.listedPrice + buyerMaxUnitPrice) / 2;
  return clamp(midpoint, item.minPrice, item.listedPrice);
}

type PriceResolution =
  | { fit: "full"; unitPrice: number }
  | { fit: "counter"; unitPrice: number }
  | { fit: "rejected" };

function resolvePrice(
  item: CatalogItemSnapshot,
  maxUnitPrice: number | undefined,
): PriceResolution {
  if (maxUnitPrice === undefined || maxUnitPrice >= item.listedPrice) {
    return { fit: "full", unitPrice: item.listedPrice };
  }

  if (!item.negotiationEnabled) {
    return { fit: "rejected" };
  }

  return { fit: "counter", unitPrice: computeCounterOfferPrice(item, maxUnitPrice) };
}

/**
 * Evaluates a buyer's negotiation request against one catalog item and
 * classifies it into exactly one outcome:
 *
 *  - EXACT_MATCH: available quantity, listed (or better) price, and
 *    standard delivery all satisfy the request with no concession needed
 *  - COUNTER_OFFER: quantity is fine, but price needed adjusting (see
 *    computeCounterOfferPrice)
 *  - PARTIAL_FULFILLMENT: available stock is short of the requested
 *    quantity — offers the maximum sellable quantity instead of
 *    rejecting the whole request outright (see reasons for any price
 *    adjustment bundled into the same offer)
 *  - REJECTED: no combination of quantity/price/delivery within this
 *    item's rules can satisfy the request (out of stock, delivery
 *    deadline faster than achievable, item SKU not found, invalid
 *    quantity, or the item is not open to negotiation and the request
 *    deviates from its exact listed terms)
 *
 * `item` may be null to represent "no catalog item found for this SKU" —
 * callers doing a real DB lookup (negotiationRepository.ts) pass through
 * whatever findCatalogItemBySku returns without needing a separate
 * null-check branch.
 */
export function evaluateNegotiationRequest(
  item: CatalogItemSnapshot | null,
  request: NegotiationRequest,
): NegotiationResult {
  if (!item) {
    return rejected(request.sku, request.quantity, [
      "No catalog item found for this SKU.",
    ]);
  }

  if (request.quantity <= 0) {
    return rejected(item.sku, request.quantity, [
      "Requested quantity must be greater than zero.",
    ]);
  }

  if (item.availableQty <= 0) {
    return rejected(item.sku, request.quantity, ["Item is out of stock."]);
  }

  const deliveryCheck = checkDeliveryAchievable(
    item,
    request.deliveryDeadlineDays,
  );
  if (!deliveryCheck.isAchievable) {
    return rejected(item.sku, request.quantity, [
      `Requested delivery in ${request.deliveryDeadlineDays} day(s) is faster than the merchant's standard ${item.standardDeliveryDays} day(s).`,
    ]);
  }

  const priceResolution = resolvePrice(item, request.maxUnitPrice);
  if (priceResolution.fit === "rejected") {
    return rejected(item.sku, request.quantity, [
      "This item is not open to negotiation; only the exact listed price can be offered.",
    ]);
  }

  const quantityCheck = checkQuantityAvailable(item, request.quantity);
  const needsQuantityAdjustment = !quantityCheck.isFullyAvailable;
  const needsPriceAdjustment = priceResolution.fit === "counter";

  if (!item.negotiationEnabled && needsQuantityAdjustment) {
    return rejected(item.sku, request.quantity, [
      "This item is not open to negotiation; only the exact requested quantity within stock can be offered.",
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
      `Countering with an adjusted unit price of ${priceResolution.unitPrice} instead of the listed ${item.listedPrice}.`,
    );
  }

  // Quantity shortfall takes priority in the top-level outcome — it's the
  // harder physical constraint — but the offered unitPrice still carries
  // any price concession, so no information is lost either way.
  const outcome: NegotiationOutcome = needsQuantityAdjustment
    ? "PARTIAL_FULFILLMENT"
    : needsPriceAdjustment
      ? "COUNTER_OFFER"
      : "EXACT_MATCH";

  return {
    outcome,
    sku: item.sku,
    requestedQuantity: request.quantity,
    offeredQuantity: quantityCheck.fulfillableQuantity,
    unitPrice: priceResolution.unitPrice,
    deliveryDays: deliveryCheck.offeredDeliveryDays,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Acceptance validation (section 9): the final gate before a negotiation
// can turn into an Agreement. Reusable by both the buyer-accepts-offer
// path and the merchant-confirms-offer path, since both must pass through
// the same constraints.
// ---------------------------------------------------------------------------

/** A specific, fully-formed set of terms someone is proposing to finalize. */
export interface ProposedAgreement {
  sku: string;
  quantity: number;
  unitPrice: number;
  deliveryDays: number;
}

export type AgreementValidationOutcome = "ACCEPTED" | "REJECTED";

export interface AgreementValidationResult {
  outcome: AgreementValidationOutcome;
  reasons: string[];
}

/**
 * Validates a proposed agreement against the merchant's real constraints.
 * This is the last line of defense before money changes hands: it is the
 * only function allowed to turn a negotiated (or exact) offer into
 * something eligible to become an Agreement record.
 */
export function validateProposedAgreement(
  item: CatalogItemSnapshot | null,
  proposal: ProposedAgreement,
): AgreementValidationResult {
  if (!item) {
    return { outcome: "REJECTED", reasons: ["No catalog item found for this SKU."] };
  }

  const reasons: string[] = [];

  if (proposal.quantity <= 0) {
    reasons.push("Quantity must be greater than zero.");
  } else if (!checkQuantityAvailable(item, proposal.quantity).isFullyAvailable) {
    reasons.push(
      `Only ${item.availableQty} unit(s) are available; proposal requests ${proposal.quantity}.`,
    );
  }

  if (proposal.unitPrice < item.minPrice) {
    reasons.push("Unit price is below the merchant's minimum acceptable price.");
  }

  if (!checkDeliveryAchievable(item, proposal.deliveryDays).isAchievable) {
    reasons.push(
      `Delivery in ${proposal.deliveryDays} day(s) is faster than the merchant's standard ${item.standardDeliveryDays} day(s).`,
    );
  }

  if (proposal.unitPrice < item.listedPrice && !item.negotiationEnabled) {
    reasons.push(
      "This item is not open to negotiation; price must match the listed price.",
    );
  }

  return reasons.length > 0
    ? { outcome: "REJECTED", reasons }
    : { outcome: "ACCEPTED", reasons: [] };
}
