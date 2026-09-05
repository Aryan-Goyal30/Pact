// Buyer quantity SUFFICIENCY — PACT V2 Milestone 6.
//
// Answers a question the codebase never asked before this milestone:
// "the merchant's offer technically satisfies my hard ceiling and price
// — but is the QUANTITY actually enough for me?" Deliberately a
// DIFFERENT question from buyerQuantityTrade.ts's "should I offer MORE
// quantity to get a better price" — that module is about the buyer
// giving something up (extra commitment) to get something (a lower
// price); this module is about the buyer deciding whether a SHORTFALL
// from what it originally needed is something it can live with. The two
// must never be conflated: a single round is either reacting to a
// shortfall or proactively offering more, never both — see
// buyerAgent.ts's buildResponseToMerchantOffer for how they're kept as
// separate, sequential checks.
//
// Pure and synchronous, same discipline as every other rules module.
// Never decides the actual counter price itself when insufficient —
// that's still buyerQuantityTrade.ts / buyerMoveSelector.ts's job; this
// only decides whether "accept the shortfall" is the right move at all.

import {
  resolveBuyerTarget,
  type BuyerConstraints,
} from "@/lib/rules/buyerRules";
import {
  QUANTITY_SHORTFALL_PRICE_COMPENSATION_SEVERITY_SCALING,
  QUANTITY_SHORTFALL_PRICE_COMPENSATION_THRESHOLD,
  resolveQuantityShortfallTolerance,
} from "@/lib/rules/negotiationStrategy";

export type QuantitySufficiencyVerdict =
  | "SUFFICIENT"
  | "INSUFFICIENT_PRICE_COMPENSATES"
  | "INSUFFICIENT";

export interface QuantitySufficiencyDecision {
  verdict: QuantitySufficiencyVerdict;
  /** 0 when the offer fully meets (or exceeds) the requested quantity; otherwise the fraction short, e.g. 0.33 for a 150 -> 100 offer. */
  shortfallFraction: number;
  /** Explicit, human-readable factors behind the verdict — never just "quantity <= requested." */
  reason: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Decides whether an offered quantity is sufficient for the buyer,
 * weighing three explicit, named factors — never a bare
 * `offeredQuantity <= requestedQuantity` check:
 *
 *  - SUFFICIENT: no shortfall at all, OR a shortfall within the buyer's
 *    own tolerance for its urgency level (explicit override via
 *    `constraints.quantityShortfallTolerance`, otherwise derived — see
 *    negotiationStrategy.resolveQuantityShortfallTolerance). A small
 *    shortfall is accepted regardless of price, by design — chasing a
 *    marginally better price over a handful of units isn't worth the
 *    friction.
 *  - INSUFFICIENT_PRICE_COMPENSATES: the shortfall exceeds ordinary
 *    tolerance, but the offered price is close enough to the buyer's own
 *    aspirational target (not merely under its hard ceiling) that the
 *    price advantage is judged worth the shortfall.
 *  - INSUFFICIENT: the shortfall exceeds tolerance and the price isn't
 *    good enough to justify it — the caller should NOT accept outright;
 *    see buyerAgent.ts for what happens instead (falls through to the
 *    existing trade/concession/hold machinery, unchanged).
 *
 * A severe shortfall becomes very hard to justify by construction: as
 * shortfallFraction grows, it must clear an unmoving tolerance line, and
 * even the maximum possible priceAdvantage (1.0, i.e. the price sits at
 * or below the buyer's own target) still requires clearing
 * QUANTITY_SHORTFALL_PRICE_COMPENSATION_THRESHOLD — there is no
 * shortfall size price alone can never justify below that fraction, and
 * no price improvement changes a severe shortfall into an easy accept.
 */
export function evaluateQuantitySufficiency(
  constraints: BuyerConstraints,
  offeredQuantity: number,
  offeredUnitPrice: number,
): QuantitySufficiencyDecision {
  const shortfallFraction =
    constraints.quantity <= 0
      ? 0
      : round2(clamp((constraints.quantity - offeredQuantity) / constraints.quantity, 0, 1));

  if (shortfallFraction <= 0) {
    return {
      verdict: "SUFFICIENT",
      shortfallFraction: 0,
      reason: "The offered quantity fully meets the requested amount.",
    };
  }

  const tolerance =
    constraints.quantityShortfallTolerance !== undefined
      ? clamp(constraints.quantityShortfallTolerance, 0, 1)
      : resolveQuantityShortfallTolerance(constraints.urgency);

  if (shortfallFraction <= tolerance) {
    return {
      verdict: "SUFFICIENT",
      shortfallFraction,
      reason: `A ${Math.round(shortfallFraction * 100)}% shortfall is within the buyer's ordinary tolerance, so no price compensation is needed.`,
    };
  }

  const target = resolveBuyerTarget(constraints);
  const priceAdvantage =
    constraints.maxUnitPrice > target
      ? clamp((constraints.maxUnitPrice - offeredUnitPrice) / (constraints.maxUnitPrice - target), 0, 1)
      : 0;

  // The bar to clear rises with how far the shortfall exceeds ordinary
  // tolerance — a shortfall only just beyond tolerance has a reachable
  // bar; a severe shortfall pushes the requirement past what the [0,1]
  // priceAdvantage scale can ever reach, so no price alone rescues it.
  const excessShortfall = shortfallFraction - tolerance;
  const requiredPriceAdvantage =
    QUANTITY_SHORTFALL_PRICE_COMPENSATION_THRESHOLD +
    excessShortfall * QUANTITY_SHORTFALL_PRICE_COMPENSATION_SEVERITY_SCALING;

  if (priceAdvantage >= requiredPriceAdvantage) {
    return {
      verdict: "INSUFFICIENT_PRICE_COMPENSATES",
      shortfallFraction,
      reason: `The ${Math.round(shortfallFraction * 100)}% shortfall exceeds ordinary tolerance, but the price is close enough to the buyer's own target to be worth accepting anyway.`,
    };
  }

  return {
    verdict: "INSUFFICIENT",
    shortfallFraction,
    reason: `The ${Math.round(shortfallFraction * 100)}% shortfall exceeds ordinary tolerance, and the price is not good enough to compensate for it.`,
  };
}
