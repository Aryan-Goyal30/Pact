// Deterministic buyer-side constraint model — Phase 5A, Part 2.
//
// Mirrors catalogRules.ts / negotiationEngine.ts in spirit: every
// function here is pure, synchronous, and unit-testable without a
// database or an LLM. The Buyer Agent's LLM never decides whether a
// merchant's proposal is acceptable — these functions do, and the LLM
// only phrases whatever these functions already decided.

import type { NegotiationRequest, ProposedAgreement } from "@/lib/rules/negotiationEngine";

/**
 * The buyer's own hard constraints for one SKU. Mirrors
 * NegotiationRequest's fields but requires maxUnitPrice and
 * deliveryDeadlineDays — a buyer validating a merchant's offer needs a
 * concrete ceiling/deadline to check against, unlike NegotiationRequest
 * where a buyer might state no constraint on those axes at all.
 */
export interface BuyerConstraints {
  sku: string;
  quantity: number;
  maxUnitPrice: number;
  deliveryDeadlineDays: number;
  buyerContext?: string;
}

/** Converts buyer constraints into the structured request the merchant engine expects. */
export function toNegotiationRequest(constraints: BuyerConstraints): NegotiationRequest {
  return {
    sku: constraints.sku,
    quantity: constraints.quantity,
    maxUnitPrice: constraints.maxUnitPrice,
    deliveryDeadlineDays: constraints.deliveryDeadlineDays,
    buyerContext: constraints.buyerContext,
  };
}

/** Is this proposal for the SKU the buyer actually requested? */
export function isSkuMatch(constraints: BuyerConstraints, proposal: ProposedAgreement): boolean {
  return proposal.sku === constraints.sku;
}

/** Is the proposed quantity acceptable — positive, and not more than the buyer asked for? */
export function isQuantityAcceptable(
  constraints: BuyerConstraints,
  proposal: ProposedAgreement,
): boolean {
  return proposal.quantity > 0 && proposal.quantity <= constraints.quantity;
}

/** Is the proposed unit price at or below the buyer's maximum? */
export function isPriceAcceptable(
  constraints: BuyerConstraints,
  proposal: ProposedAgreement,
): boolean {
  return proposal.unitPrice <= constraints.maxUnitPrice;
}

/** Is the proposed delivery time at or before the buyer's deadline? */
export function isDeliveryAcceptable(
  constraints: BuyerConstraints,
  proposal: ProposedAgreement,
): boolean {
  return proposal.deliveryDays <= constraints.deliveryDeadlineDays;
}

export type BuyerValidationOutcome = "ACCEPTABLE" | "UNACCEPTABLE";

export interface BuyerValidationResult {
  outcome: BuyerValidationOutcome;
  reasons: string[];
}

/**
 * Runs all four buyer-side checks against a merchant's proposal. This is
 * the single gate the Buyer Agent's decision logic goes through — an
 * LLM-proposed "accept" is only ever acted on if this function agrees.
 */
export function validateMerchantProposal(
  constraints: BuyerConstraints,
  proposal: ProposedAgreement,
): BuyerValidationResult {
  const reasons: string[] = [];

  if (!isSkuMatch(constraints, proposal)) {
    reasons.push(`Proposal is for ${proposal.sku}, but ${constraints.sku} was requested.`);
  }
  if (!isQuantityAcceptable(constraints, proposal)) {
    reasons.push(
      `Offered quantity ${proposal.quantity} is not acceptable (requested up to ${constraints.quantity}).`,
    );
  }
  if (!isPriceAcceptable(constraints, proposal)) {
    reasons.push(
      `Offered unit price ${proposal.unitPrice} exceeds the buyer's maximum of ${constraints.maxUnitPrice}.`,
    );
  }
  if (!isDeliveryAcceptable(constraints, proposal)) {
    reasons.push(
      `Offered delivery of ${proposal.deliveryDays} day(s) exceeds the buyer's deadline of ${constraints.deliveryDeadlineDays} day(s).`,
    );
  }

  return reasons.length > 0
    ? { outcome: "UNACCEPTABLE", reasons }
    : { outcome: "ACCEPTABLE", reasons: [] };
}
