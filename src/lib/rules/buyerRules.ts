// Deterministic buyer-side constraint model — Phase 5A, Part 2.
//
// Mirrors catalogRules.ts / negotiationEngine.ts in spirit: every
// function here is pure, synchronous, and unit-testable without a
// database or an LLM. The Buyer Agent's LLM never decides whether a
// merchant's proposal is acceptable — these functions do, and the LLM
// only phrases whatever these functions already decided.

import type { NegotiationRequest, ProposedAgreement } from "@/lib/rules/negotiationEngine";
import {
  hasQuantityLeverage,
  resolveUrgencyConcessionFactor,
  resolveRoundProgressFactor,
  LARGE_ORDER_TARGET_DISCOUNT,
  type UrgencyLevel,
} from "@/lib/rules/negotiationStrategy";

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
  /**
   * How eager the buyer is to close quickly. "medium" (the default when
   * omitted) reproduces the exact concession behavior this field
   * predates — see negotiationStrategy.resolveUrgencyConcessionFactor.
   * High urgency makes the buyer less aggressive on price (moves toward
   * its ceiling faster); low urgency allows stronger bargaining.
   */
  urgency?: UrgencyLevel;
  /**
   * Whether the buyer will accept a later delivery date in exchange for
   * a price concession — see negotiationStrategy.resolveDeliveryTrade.
   * Only meaningful to the merchant's round-aware concession logic;
   * omitted (false) reproduces existing behavior exactly.
   */
  deliveryFlexible?: boolean;
  /**
   * Milestone 6: how much shortfall from `quantity` (as a fraction,
   * e.g. 0.2 = up to 20% less than requested) the buyer will tolerate
   * without needing the price to compensate for it — see
   * buyerQuantitySufficiency.ts. Optional: when omitted, a sensible
   * default is derived purely from `urgency` (see
   * negotiationStrategy.resolveQuantityShortfallTolerance) — no caller
   * is required to state this explicitly, and every caller that predates
   * Milestone 6 (which never even checked for a shortfall floor) still
   * gets a real, principled default rather than no floor at all.
   */
  quantityShortfallTolerance?: number;
}

/** Converts buyer constraints into the structured request the merchant engine expects. */
export function toNegotiationRequest(constraints: BuyerConstraints): NegotiationRequest {
  return {
    sku: constraints.sku,
    quantity: constraints.quantity,
    maxUnitPrice: constraints.maxUnitPrice,
    deliveryDeadlineDays: constraints.deliveryDeadlineDays,
    buyerContext: constraints.buyerContext,
    deliveryFlexible: constraints.deliveryFlexible,
  };
}

/** Is this proposal for the SKU the buyer actually requested? */
export function isSkuMatch(constraints: BuyerConstraints, proposal: ProposedAgreement): boolean {
  return proposal.sku === constraints.sku;
}

/**
 * Is the proposed quantity acceptable — positive, and not more than the
 * buyer is actually willing to take?
 *
 * `maxAcceptableQuantity` defaults to `constraints.quantity` (the
 * buyer's original requirement) when omitted — exactly the pre-Milestone-5
 * behavior every existing caller relies on. Milestone 5's
 * quantity-for-price trade lets the buyer deliberately ask for MORE than
 * its original quantity in exchange for a better price (see
 * buyerQuantityTrade.ts); once it has, the merchant's own offer mirroring
 * that larger ask must not be rejected here as "too much" — the caller
 * (buyerAgent.ts) passes the buyer's own most recent ask as the ceiling
 * in that case. Never affects merchant-side stock limits — those are
 * checked separately by negotiationEngine.ts's checkQuantityAvailable /
 * validateProposedAgreement.
 */
export function isQuantityAcceptable(
  constraints: BuyerConstraints,
  proposal: ProposedAgreement,
  maxAcceptableQuantity: number = constraints.quantity,
): boolean {
  return proposal.quantity > 0 && proposal.quantity <= maxAcceptableQuantity;
}

/** Is the proposed unit price at or below the buyer's maximum? */
export function isPriceAcceptable(
  constraints: BuyerConstraints,
  proposal: ProposedAgreement,
): boolean {
  return proposal.unitPrice <= constraints.maxUnitPrice;
}

/**
 * Is the proposed delivery time at or before what the buyer is actually
 * willing to accept?
 *
 * `maxAcceptableDeliveryDays` defaults to `constraints.deliveryDeadlineDays`
 * (the buyer's original deadline) when omitted — exactly the
 * pre-Milestone-7 behavior every existing caller relies on. Milestone 7's
 * delivery-for-price trade lets the buyer deliberately offer a LATER date
 * than its original deadline in exchange for a better price (see
 * buyerDeliveryTrade.ts); once it has, the merchant's own offer mirroring
 * that later date must not be rejected here as "too slow" — the caller
 * (buyerAgent.ts) passes the buyer's own most recent ask as the ceiling
 * in that case. Mirrors isQuantityAcceptable's own Milestone 5 fix
 * exactly, for the delivery dimension.
 */
export function isDeliveryAcceptable(
  constraints: BuyerConstraints,
  proposal: ProposedAgreement,
  maxAcceptableDeliveryDays: number = constraints.deliveryDeadlineDays,
): boolean {
  return proposal.deliveryDays <= maxAcceptableDeliveryDays;
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
 *
 * `maxAcceptableQuantity` — see isQuantityAcceptable — defaults to
 * `constraints.quantity`, exactly the pre-Milestone-5 behavior.
 * `maxAcceptableDeliveryDays` — see isDeliveryAcceptable — defaults to
 * `constraints.deliveryDeadlineDays`, exactly the pre-Milestone-7 behavior.
 */
export function validateMerchantProposal(
  constraints: BuyerConstraints,
  proposal: ProposedAgreement,
  maxAcceptableQuantity: number = constraints.quantity,
  maxAcceptableDeliveryDays: number = constraints.deliveryDeadlineDays,
): BuyerValidationResult {
  const reasons: string[] = [];

  if (!isSkuMatch(constraints, proposal)) {
    reasons.push(`Proposal is for ${proposal.sku}, but ${constraints.sku} was requested.`);
  }
  if (!isQuantityAcceptable(constraints, proposal, maxAcceptableQuantity)) {
    reasons.push(
      `Offered quantity ${proposal.quantity} is not acceptable (requested up to ${maxAcceptableQuantity}).`,
    );
  }
  if (!isPriceAcceptable(constraints, proposal)) {
    reasons.push(
      `Offered unit price ${proposal.unitPrice} exceeds the buyer's maximum of ${constraints.maxUnitPrice}.`,
    );
  }
  if (!isDeliveryAcceptable(constraints, proposal, maxAcceptableDeliveryDays)) {
    reasons.push(
      `Offered delivery of ${proposal.deliveryDays} day(s) exceeds the buyer's deadline of ${maxAcceptableDeliveryDays} day(s).`,
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
 *
 * A large order (negotiationStrategy.hasQuantityLeverage) pulls the
 * target further down — bulk buyers open asking for a deeper discount —
 * still clamped to [0, maxUnitPrice]. Below the leverage threshold
 * (every existing fixture in this codebase, including the 200-unit demo
 * scenario) this is a no-op.
 */
export function resolveBuyerTarget(constraints: BuyerConstraints): number {
  const base =
    constraints.targetUnitPrice !== undefined
      ? clamp(constraints.targetUnitPrice, 0, constraints.maxUnitPrice)
      : Math.round(constraints.maxUnitPrice * (1 - DEFAULT_BUYER_TARGET_DISCOUNT));

  if (!hasQuantityLeverage(constraints.quantity)) {
    return base;
  }
  return clamp(Math.round(base * (1 - LARGE_ORDER_TARGET_DISCOUNT)), 0, constraints.maxUnitPrice);
}

/** Round context an orchestrator supplies to computeBuyerConcessionPrice. */
export interface BuyerConcessionContext {
  /** Which buyer response this is, 1-indexed — the opening request is round 1. */
  round: number;
  maxRounds: number;
  /**
   * Negotiation Engine V2 — an already-resolved multiplier from
   * negotiationStrategy.resolveLeverageSpeedFactor(buyerLeverage,
   * merchantLeverage), reflecting the buyer's OWN leverage relative to
   * the merchant's this round. Defaults to 1.0 (a complete no-op) when
   * omitted — every caller that predates this option (including every
   * existing test) behaves exactly as before. Computed by the caller
   * (buyerMoveSelector.ts), never re-derived here — this function stays
   * a pure formula over already-resolved numbers, the same discipline
   * negotiationEngine.ts's own reciprocitySpeedMultiplier already
   * established for the symmetric merchant-side case.
   */
  leverageSpeedFactor?: number;
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
 *
 * The step size is additionally scaled by constraints.urgency
 * (negotiationStrategy.resolveUrgencyConcessionFactor) — "medium", the
 * default when urgency is unset, reproduces a multiplier of exactly 1,
 * i.e. today's plain halving formula, unchanged.
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

  const urgencyFactor = resolveUrgencyConcessionFactor(constraints.urgency);
  // Negotiation Engine V2: leverage (opt-in, see BuyerConcessionContext's
  // own doc comment) and round progression receive the symmetric
  // treatment to the merchant side's own combinedSpeed — same outer
  // clamp band, same "no-op when omitted / at the round-2-of-4 midpoint"
  // properties. Deliberately inert on round 1, mirroring
  // computeMerchantConcessionPrice's own opening-round exemption exactly
  // (this function is never actually called on the buyer's real round 1
  // in this codebase — buildOpeningRequest/resolveBuyerTarget handles
  // that directly — but the guard keeps this function correct in
  // isolation too, never dependent on that calling convention).
  const isOpeningRound = context.round <= 1;
  const leverageFactor = isOpeningRound ? 1 : (context.leverageSpeedFactor ?? 1);
  const roundProgressFactor = isOpeningRound ? 1 : resolveRoundProgressFactor(context.round, context.maxRounds);
  const combinedFactor = clamp(urgencyFactor * leverageFactor * roundProgressFactor, 0.3, 2.0);
  const conceded = target + ((merchantOfferUnitPrice - target) / 2) * combinedFactor;
  return clamp(Math.round(conceded), target, constraints.maxUnitPrice);
}
