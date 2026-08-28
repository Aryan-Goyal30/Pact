// PACT V2 Milestone 11 — MANDATORY old-vs-new equivalence proof, merchant
// side. Mirrors buyerMoveSelection.oldVsNew.test.ts's discipline exactly:
// every scenario is either a real fixture reused verbatim from
// merchantAgent.test.ts/orchestrator.test.ts's own real numbers, or a
// real CatalogItemSnapshot + NegotiationRequest swept across a
// representative range of stock levels and rounds. generateMerchantCandidates
// is always the real function; no candidate array is hand-constructed to
// produce a desired equivalence result.

import { describe, expect, it } from "vitest";
import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import type { MerchantConcessionContext, NegotiationRequest } from "@/lib/rules/negotiationEngine";
import {
  generateMerchantCandidates,
  isTradeCandidate,
  scoreMerchantCandidate,
  selectBestMerchantCandidate,
} from "./merchantMoveSelection";
import type { CandidateMove } from "./candidateMove";

/**
 * Reconstructs EXACTLY the pre-Milestone-11 (Milestone 9/10) two-tier
 * filter+reduce selection algorithm — an eligible trade unconditionally
 * preferred over any non-trade, raw price only deciding within a tier —
 * using the SAME isTradeCandidate classification compareMerchantPackages
 * now uses internally (never a second, independently-drifting
 * definition). Kept here, not in production code, purely as the "old"
 * reference implementation this file compares Milestone 11's new
 * comparator against.
 */
function oldSelectBestMerchantCandidate(candidates: CandidateMove[]): CandidateMove {
  const highestScoring = (pool: CandidateMove[]): CandidateMove =>
    pool.reduce((best, candidate) =>
      scoreMerchantCandidate(candidate) > scoreMerchantCandidate(best) ? candidate : best,
    );
  const trades = candidates.filter(isTradeCandidate);
  if (trades.length > 0) {
    return highestScoring(trades);
  }
  return highestScoring(candidates.filter((c) => !isTradeCandidate(c)));
}

function sameWinner(a: CandidateMove, b: CandidateMove): boolean {
  return (
    a.move === b.move &&
    a.unitPrice === b.unitPrice &&
    a.quantity === b.quantity &&
    a.deliveryDays === b.deliveryDays
  );
}

const item: CatalogItemSnapshot = {
  sku: "LAPTOP-14-I5",
  listedPrice: 48000,
  minPrice: 44000,
  availableQty: 100,
  standardDeliveryDays: 5,
  maxDeliveryDays: 20,
  negotiationEnabled: true,
};

interface Scenario {
  label: string;
  item: CatalogItemSnapshot;
  request: NegotiationRequest & { maxUnitPrice: number };
  concessionContext: MerchantConcessionContext;
  priorBuyerUnitPrice?: number | null;
  previousBuyerQuantity?: number | null;
  previousBuyerDeliveryDays?: number | null;
}

const namedScenarios: Scenario[] = [
  // E: abundant stock -> quantity trade wins (real merchantAgent.test.ts /
  // orchestrator.test.ts fixture).
  {
    label: "E-abundant: quantity trade wins on abundant stock (real fixture)",
    item: { ...item, availableQty: 5000 },
    request: { sku: item.sku, quantity: 300, maxUnitPrice: 44500, deliveryDeadlineDays: 12, deliveryFlexible: true },
    concessionContext: { round: 2, maxRounds: 8, previousOfferUnitPrice: 46000 },
    previousBuyerQuantity: 150,
    previousBuyerDeliveryDays: 8,
  },
  // E: constrained stock -> delivery trade wins instead, same code path.
  {
    label: "E-constrained: delivery trade wins on constrained stock (real fixture)",
    item: { ...item, availableQty: 15 },
    request: { sku: item.sku, quantity: 300, maxUnitPrice: 44500, deliveryDeadlineDays: 12, deliveryFlexible: true },
    concessionContext: { round: 2, maxRounds: 8, previousOfferUnitPrice: 46000 },
    previousBuyerQuantity: 150,
    previousBuyerDeliveryDays: 8,
  },
  // Merchant HOLD (scarce stock, bulk order) — real merchantAgent.test.ts fixture.
  {
    label: "HOLD: scarce stock, bulk order (real fixture)",
    item: { ...item, availableQty: 15 },
    request: { sku: item.sku, quantity: 300, maxUnitPrice: 44100 },
    concessionContext: { round: 2, maxRounds: 6, previousOfferUnitPrice: 45600 },
  },
  // Ordinary reciprocity-driven CONCEDE (real merchantAgent.test.ts fixture).
  {
    label: "CONCEDE: reciprocity-driven genuine concession (real fixture)",
    item,
    request: { sku: item.sku, quantity: 10, maxUnitPrice: 45000 },
    concessionContext: { round: 2, maxRounds: 4, previousOfferUnitPrice: 46500 },
    priorBuyerUnitPrice: 44000,
  },
];

// A sweep across stock levels and rounds, both with and without a
// simultaneous genuine quantity+delivery increase signal — real
// CatalogItemSnapshot/NegotiationRequest, real generateMerchantCandidates.
const sweepScenarios: Scenario[] = [15, 50, 100, 300, 5000].flatMap((availableQty) =>
  [2, 3, 5].map((round) => ({
    label: `sweep: availableQty=${availableQty} round=${round} (bulk + delivery signal)`,
    item: { ...item, availableQty },
    request: {
      sku: item.sku,
      quantity: 300,
      maxUnitPrice: 44500,
      deliveryDeadlineDays: 12,
      deliveryFlexible: true,
    },
    concessionContext: { round, maxRounds: 8, previousOfferUnitPrice: 46200 },
    previousBuyerQuantity: 150,
    previousBuyerDeliveryDays: 8,
  })),
);

describe("Milestone 11: OLD (two-tier filter+reduce) vs NEW (package comparator) merchant selector — mandatory equivalence proof", () => {
  it.each([...namedScenarios, ...sweepScenarios])(
    "$label",
    ({ item, request, concessionContext, priorBuyerUnitPrice, previousBuyerQuantity, previousBuyerDeliveryDays }) => {
      // Milestone 12: the same authoritative, stock-capped quantity
      // applyMerchantConcession would derive from evaluateNegotiationRequest's
      // own decision.offeredQuantity — reconstructed here the same way
      // checkQuantityAvailable computes it, not re-derived independently.
      const authorizedQuantity = Math.min(request.quantity, item.availableQty);
      const { candidates } = generateMerchantCandidates(
        item,
        request,
        concessionContext,
        priorBuyerUnitPrice,
        previousBuyerQuantity,
        previousBuyerDeliveryDays,
        authorizedQuantity,
      );

      const oldWinner = oldSelectBestMerchantCandidate(candidates);
      const newWinner = selectBestMerchantCandidate(candidates);

      expect(sameWinner(newWinner, oldWinner)).toBe(true);
    },
  );

  // Milestone 12 update: this fixture's item/request shape ALSO
  // satisfies the new combined package's own eligibility (both
  // dimensions genuinely increase together) — oldSelectBestMerchantCandidate
  // uses the SAME, now-widened isTradeCandidate this file imports from
  // merchantMoveSelection.ts (by design — see that export's own doc
  // comment: never a second, independently-drifting definition), so
  // "OLD" here means "the pre-Milestone-11 comparison ALGORITHM,"
  // applied to today's real candidate set — not "frozen at exactly
  // Milestone 9's own candidate types forever." Both OLD and NEW still
  // independently agree with EACH OTHER (the actual equivalence
  // property this file exists to prove) on genuinely different winners
  // as stock changes — now combined-at-abundant vs delivery-at-constrained.
  it("E: both OLD and NEW selectors independently flip from the combined package to solo delivery as stock changes, not merely 'the same as each other'", () => {
    const abundant = namedScenarios[0];
    const constrained = namedScenarios[1];

    const abundantCandidates = generateMerchantCandidates(
      abundant.item,
      abundant.request,
      abundant.concessionContext,
      abundant.priorBuyerUnitPrice,
      abundant.previousBuyerQuantity,
      abundant.previousBuyerDeliveryDays,
      Math.min(abundant.request.quantity, abundant.item.availableQty),
    ).candidates;
    const constrainedCandidates = generateMerchantCandidates(
      constrained.item,
      constrained.request,
      constrained.concessionContext,
      constrained.priorBuyerUnitPrice,
      constrained.previousBuyerQuantity,
      constrained.previousBuyerDeliveryDays,
      Math.min(constrained.request.quantity, constrained.item.availableQty),
    ).candidates;

    expect(oldSelectBestMerchantCandidate(abundantCandidates).move).toBe("QUANTITY_AND_DELIVERY_FOR_PRICE");
    expect(selectBestMerchantCandidate(abundantCandidates).move).toBe("QUANTITY_AND_DELIVERY_FOR_PRICE");
    expect(oldSelectBestMerchantCandidate(constrainedCandidates).move).toBe("DELIVERY_FOR_PRICE");
    expect(selectBestMerchantCandidate(constrainedCandidates).move).toBe("DELIVERY_FOR_PRICE");
  });
});
