// PACT V2 Milestone 11 — MANDATORY old-vs-new equivalence proof.
//
// Milestone 11's own approval message requires this explicitly: before
// (and after) wiring the new package comparator (compareBuyerPackages)
// into selectBestBuyerCandidate, its output must be compared against
// Milestone 9/10's price-only selector across every existing candidate
// fixture/scenario, confirming the same candidate wins wherever the old
// selector won. This file is that proof, kept permanently (not a
// throwaway probe) so a future change to either selector re-runs it.
//
// Every scenario below is either a REAL fixture reused verbatim from
// orchestrator.test.ts's own real, orchestrator-verified numbers, or a
// real BuyerConstraints swept across a representative range of
// leverage/round/quantity/delivery combinations — generateBuyerCandidates
// is always the real function; no candidate array is hand-constructed to
// produce a desired equivalence result.

import { describe, expect, it } from "vitest";
import type { BuyerConcessionContext, BuyerConstraints } from "@/lib/rules/buyerRules";
import {
  generateBuyerCandidates,
  scoreBuyerCandidate,
  selectBestBuyerCandidate,
  type BuyerCandidateStrategyContext,
} from "./buyerMoveSelection";
import type { CandidateMove } from "./candidateMove";

/**
 * Reconstructs EXACTLY the pre-Milestone-11 (Milestone 9/10) selection
 * algorithm — plain lowest-price-wins via scoreBuyerCandidate, with
 * Array.prototype.reduce's own strict `<` tie-break (first-encountered
 * wins on an exact tie) — unchanged since Milestone 9. Deliberately kept
 * here, not in production code: this is the "old" reference
 * implementation this file compares Milestone 11's new comparator
 * against, not something any real caller should use going forward.
 */
function oldSelectBestBuyerCandidate(candidates: CandidateMove[]): CandidateMove {
  return candidates.reduce((best, candidate) =>
    scoreBuyerCandidate(candidate) < scoreBuyerCandidate(best) ? candidate : best,
  );
}

function sameWinner(a: CandidateMove, b: CandidateMove): boolean {
  return (
    a.move === b.move &&
    a.unitPrice === b.unitPrice &&
    a.quantity === b.quantity &&
    a.deliveryDays === b.deliveryDays
  );
}

interface Scenario {
  label: string;
  constraints: BuyerConstraints;
  merchantOfferUnitPrice: number;
  merchantOfferedQuantity: number;
  concessionContext: BuyerConcessionContext;
  strategyContext: BuyerCandidateStrategyContext;
}

const namedScenarios: Scenario[] = [
  // A: quantity-trade round — orchestrator.test.ts's real round-2 inputs
  // (quantity trade clearly wins on price today: 43963 < 44897).
  {
    label: "A: quantity-trade round (real orchestrator inputs)",
    constraints: {
      sku: "LAPTOP-14-I5",
      quantity: 50,
      maxUnitPrice: 45500,
      deliveryDeadlineDays: 10,
      urgency: "high",
    },
    merchantOfferUnitPrice: 45613,
    merchantOfferedQuantity: 50,
    concessionContext: { round: 2, maxRounds: 10 },
    strategyContext: {
      previousBuyerUnitPrice: 43225,
      leverageScore: 54,
      quantityTradeAlreadyUsed: false,
      deliveryTradeAlreadyUsed: false,
    },
  },
  // B: delivery-trade round, partial fulfillment (quantity dimension
  // structurally blocked) — orchestrator.test.ts's real round-2 inputs.
  {
    label: "B: delivery-trade round, partial fulfillment (real orchestrator inputs)",
    constraints: {
      sku: "LAPTOP-14-I5",
      quantity: 40,
      maxUnitPrice: 45500,
      deliveryDeadlineDays: 8,
      urgency: "high",
      deliveryFlexible: true,
    },
    merchantOfferUnitPrice: 46209,
    merchantOfferedQuantity: 30,
    concessionContext: { round: 2, maxRounds: 10 },
    strategyContext: {
      previousBuyerUnitPrice: 43225,
      leverageScore: 26,
      quantityTradeAlreadyUsed: false,
      deliveryTradeAlreadyUsed: false,
    },
  },
  // D: the 3-way tie at the buyer's own floor target (HOLD vs both
  // trades) — the single most important case to re-verify: at very
  // strong leverage, all three candidates' prices coincide exactly, so
  // this is where a new tie-break tier (delivery) could most plausibly
  // change the winner. It does not — see the assertion below.
  {
    label: "D: 3-way tie at the buyer's floor (real orchestrator inputs)",
    constraints: {
      sku: "LAPTOP-14-I5",
      quantity: 20,
      maxUnitPrice: 44300,
      deliveryDeadlineDays: 10,
      urgency: "low",
      deliveryFlexible: true,
    },
    merchantOfferUnitPrice: 44843,
    merchantOfferedQuantity: 20,
    concessionContext: { round: 2, maxRounds: 10 },
    strategyContext: {
      previousBuyerUnitPrice: 42085,
      leverageScore: 96,
      quantityTradeAlreadyUsed: false,
      deliveryTradeAlreadyUsed: false,
    },
  },
];

// A wide sweep across leverage/round combinations, in two situational
// shapes: (1) delivery-flexible, full stock — every dimension eligible;
// (2) a genuine partial-fulfillment shortfall, delivery-inflexible —
// the one shape that actually exercises the NEW sufficiency tier for
// real (a 40% shortfall against the buyer's own requested quantity).
// Real BuyerConstraints and the real generateBuyerCandidates throughout.
const sweepScenarios: Scenario[] = [10, 25, 40, 55, 70, 85, 100].flatMap((leverageScore) =>
  [2, 3, 5].flatMap((round) => [
    {
      label: `sweep: leverage=${leverageScore} round=${round} (delivery-flexible, full stock)`,
      constraints: {
        sku: "LAPTOP-14-I5",
        quantity: 50,
        maxUnitPrice: 46000,
        deliveryDeadlineDays: 10,
        urgency: "medium" as const,
        deliveryFlexible: true,
      },
      merchantOfferUnitPrice: 46800,
      merchantOfferedQuantity: 50,
      concessionContext: { round, maxRounds: 8 },
      strategyContext: {
        priorMerchantUnitPrice: 47200,
        previousBuyerUnitPrice: 44300,
        leverageScore,
        quantityTradeAlreadyUsed: false,
        deliveryTradeAlreadyUsed: false,
      },
    },
    {
      label: `sweep: leverage=${leverageScore} round=${round} (partial fulfillment, delivery-inflexible)`,
      constraints: {
        sku: "LAPTOP-14-I5",
        quantity: 40,
        maxUnitPrice: 45800,
        deliveryDeadlineDays: 8,
        urgency: "high" as const,
      },
      merchantOfferUnitPrice: 46400,
      merchantOfferedQuantity: 30, // a genuine 25% shortfall -> exercises the sufficiency tier for real
      concessionContext: { round, maxRounds: 8 },
      strategyContext: {
        priorMerchantUnitPrice: 46900,
        previousBuyerUnitPrice: 44000,
        leverageScore,
        quantityTradeAlreadyUsed: false,
        deliveryTradeAlreadyUsed: false,
      },
    },
  ]),
);

describe("Milestone 11: OLD (price-only) vs NEW (package comparator) buyer selector — mandatory equivalence proof", () => {
  it.each([...namedScenarios, ...sweepScenarios])(
    "$label",
    ({ constraints, merchantOfferUnitPrice, merchantOfferedQuantity, concessionContext, strategyContext }) => {
      // maxDeliveryDays = Infinity: this file exists solely to prove
      // old-vs-new SELECTOR equivalence, unrelated to the delivery-trade
      // ceiling fix — Infinity guarantees the clamp is a mathematical
      // no-op (min(computed, Infinity) === computed always) for every
      // fixture below, so none of them need re-deriving.
      const candidates = generateBuyerCandidates(
        constraints,
        merchantOfferUnitPrice,
        merchantOfferedQuantity,
        concessionContext,
        strategyContext,
        Number.POSITIVE_INFINITY,
      );

      const oldWinner = oldSelectBestBuyerCandidate(candidates);
      const newWinner = selectBestBuyerCandidate(
        candidates,
        constraints,
        merchantOfferedQuantity,
        constraints.deliveryDeadlineDays,
      );

      expect(sameWinner(newWinner, oldWinner)).toBe(true);
    },
  );

  // The D scenario's own winner, pinned explicitly (not just "matches
  // old") — confirms the equivalence proof above isn't vacuously true
  // because both selectors happened to break the tie the same way by
  // accident; HOLD is the real, expected winner on both sides.
  it("D: both OLD and NEW selectors independently land on HOLD, not merely 'the same as each other'", () => {
    const scenario = namedScenarios[2];
    const candidates = generateBuyerCandidates(
      scenario.constraints,
      scenario.merchantOfferUnitPrice,
      scenario.merchantOfferedQuantity,
      scenario.concessionContext,
      scenario.strategyContext,
      Number.POSITIVE_INFINITY,
    );
    expect(oldSelectBestBuyerCandidate(candidates).move).toBe("HOLD");
    expect(
      selectBestBuyerCandidate(
        candidates,
        scenario.constraints,
        scenario.merchantOfferedQuantity,
        scenario.constraints.deliveryDeadlineDays,
      ).move,
    ).toBe("HOLD");
  });
});
