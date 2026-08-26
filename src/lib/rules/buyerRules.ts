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
  /**
   * The buyer's aspirational opening price — what it would like to pay,
   * distinct from maxUnitPrice (the hard ceiling it will never exceed).
   * Optional: when omitted, resolveBuyerTarget() derives one so a
   * caller only has to supply a ceiling, same as before.
   */
  targetUnitPrice?: number;
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

// ---------------------------------------------------------------------------
// Buyer concession strategy — Phase 5B.
//
// Symmetric to negotiationEngine.ts's computeMerchantConcessionPrice: the
// buyer does not simply reveal and hold at maxUnitPrice from round one.
// It opens near a lower, aspirational target and only moves toward its
// true ceiling gradually, and only as far as it has to.
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** How far below its hard ceiling the buyer's opening aspiration starts, when no explicit targetUnitPrice is given. */
export const DEFAULT_BUYER_TARGET_DISCOUNT = 0.05;

/**
 * Resolves the buyer's aspirational target price: the explicit
 * `targetUnitPrice` if the caller supplied one, otherwise a price a
 * fixed 5% below maxUnitPrice. This never depends on any merchant data
 * (listed price, floor, etc.) — it's purely a function of the buyer's
 * own stated ceiling, so it works the same way for any product.
 */
export function resolveBuyerTarget(constraints: BuyerConstraints): number {
  if (constraints.targetUnitPrice !== undefined) {
    return clamp(constraints.targetUnitPrice, 0, constraints.maxUnitPrice);
  }
  return Math.round(constraints.maxUnitPrice * (1 - DEFAULT_BUYER_TARGET_DISCOUNT));
}

/** Round context an orchestrator supplies to computeBuyerConcessionPrice. */
export interface BuyerConcessionContext {
  /** Which buyer response this is, 1-indexed — the opening request is round 1. */
  round: number;
  maxRounds: number;
}

/**
 * Round-aware buyer concession strategy.
 *
 * maxUnitPrice is a hard ceiling, never a target — the buyer tries to
 * hold as close to its own target as it can, and only surrenders ground
 * gradually:
 *
 *  - Each round (until the last two), it moves half the remaining gap
 *    between its own target and the merchant's CURRENT offer — the same
 *    "split the remaining difference" shape as the merchant's strategy,
 *    just aimed the opposite direction. Because it re-anchors on the
 *    merchant's live offer every round rather than blindly repeating a
 *    fixed number, the buyer's own offer changes as the merchant's does
 *    — including moving back down if the merchant's offer improves a
 *    lot in one round, which is the economically rational reaction.
 *  - On the final two rounds, it goes all the way to its true ceiling
 *    rather than lose a deal that's still worth having over the last
 *    sliver of leverage — symmetric to the merchant settling at the
 *    buyer's ceiling on its own final rounds.
 *  - The result is always clamped to [target, maxUnitPrice], so it can
 *    never exceed the buyer's hard ceiling no matter what the merchant
 *    is asking or how many rounds have passed.
 *
 * This function only computes a NUMBER; it never decides whether to
 * accept, reject, or counter — buyerAgent.ts's validateMerchantProposal
 * check does that, same as before this function existed.
 */
export function computeBuyerConcessionPrice(
  constraints: BuyerConstraints,
  merchantOfferUnitPrice: number,
  context: BuyerConcessionContext,
): number {
  const target = resolveBuyerTarget(constraints);
  const roundsLeft = Math.max(1, context.maxRounds - context.round + 1);

  if (roundsLeft <= 2) {
    return constraints.maxUnitPrice;
  }

  const conceded = target + (merchantOfferUnitPrice - target) / 2;
  return clamp(Math.round(conceded), target, constraints.maxUnitPrice);
}
