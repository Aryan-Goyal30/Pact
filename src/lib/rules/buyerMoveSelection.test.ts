import { describe, expect, it } from "vitest";
import type { BuyerConcessionContext, BuyerConstraints } from "@/lib/rules/buyerRules";
import {
  compareBuyerPackages,
  generateBuyerCandidates,
  scoreBuyerCandidate,
  selectBestBuyerCandidate,
  type BuyerCandidateStrategyContext,
} from "./buyerMoveSelection";
import { evaluateQuantitySufficiency } from "./buyerQuantitySufficiency";
import type { CandidateMove } from "./candidateMove";

const constraints: BuyerConstraints = {
  sku: "LAPTOP-14-I5",
  quantity: 50,
  maxUnitPrice: 46000,
  deliveryDeadlineDays: 10,
  deliveryFlexible: true,
};

function ctx(round: number, maxRounds = 8): BuyerConcessionContext {
  return { round, maxRounds };
}

// A permissive strategy context — round is mid-negotiation, plenty of
// rounds remain, leverage is defined, neither chip used yet, so every
// candidate's own eligibility gate is open and generateBuyerCandidates
// has the freest possible hand to produce all of them at once.
const openStrategy: BuyerCandidateStrategyContext = {
  priorMerchantUnitPrice: 47000,
  previousBuyerUnitPrice: 44000,
  leverageScore: 60,
  quantityTradeAlreadyUsed: false,
  deliveryTradeAlreadyUsed: false,
};

// The computed delivery give below is 10 + round(10*0.5) = 15. 20 is
// deliberately well above that, so every existing test in this file
// exercises the "computed <= maxDeliveryDays, behavior unchanged" case
// (Milestone hardening req. 5) — the clamp itself is covered in
// buyerDeliveryTrade.test.ts / buyerQuantityAndDeliveryTrade.test.ts.
const maxDeliveryDays = 20;

describe("generateBuyerCandidates — adapters map existing decisions correctly", () => {
  it("the ordinary decision (decideBuyerConcessionMove) always adapts into the first candidate, whatever move it picked", () => {
    const candidates = generateBuyerCandidates(constraints, 46800, 50, ctx(3), openStrategy, maxDeliveryDays);
    expect(candidates[0].move === "HOLD" || candidates[0].move === "CONCEDE").toBe(true);
    expect(candidates[0].unitPrice).toBeGreaterThan(0);
    expect(candidates[0].quantity).toBeUndefined();
    expect(candidates[0].deliveryDays).toBeUndefined();
    expect(typeof candidates[0].reason).toBe("string");
    expect(candidates[0].reason.length).toBeGreaterThan(0);
  });

  it("a firing quantity trade (decideBuyerQuantityTrade) adapts its quantity/unitPrice/reason verbatim into a QUANTITY_FOR_PRICE candidate", () => {
    const candidates = generateBuyerCandidates(constraints, 46800, 50, ctx(3), openStrategy, maxDeliveryDays);
    const trade = candidates.find((c) => c.move === "QUANTITY_FOR_PRICE");
    expect(trade).toBeDefined();
    // Buyer Quantity-for-Price Redesign — verified live: 57, not the old
    // flat-doubled 100 (see resolveQuantityTradeIncreaseFraction).
    expect(trade!.quantity).toBe(57);
    expect(trade!.deliveryDays).toBeUndefined();
    expect(trade!.reason).toContain("increase the order to 57 units");
  });

  it("a firing delivery trade (decideBuyerDeliveryTrade) adapts its deliveryDays/unitPrice/reason verbatim into a DELIVERY_FOR_PRICE candidate", () => {
    const candidates = generateBuyerCandidates(constraints, 46800, 50, ctx(3), openStrategy, maxDeliveryDays);
    const trade = candidates.find((c) => c.move === "DELIVERY_FOR_PRICE");
    expect(trade).toBeDefined();
    expect(trade!.deliveryDays).toBe(15); // 10 + round(10 * 0.5)
    expect(trade!.quantity).toBeUndefined();
    expect(trade!.reason).toContain("accept delivery in 15 days");
  });

  it("a NO_TRADE verdict from either module never produces a candidate for that dimension", () => {
    // deliveryFlexible false -> decideBuyerDeliveryTrade always returns NO_TRADE.
    const inflexible: BuyerConstraints = { ...constraints, deliveryFlexible: false };
    const candidates = generateBuyerCandidates(inflexible, 46800, 50, ctx(3), openStrategy, maxDeliveryDays);
    expect(candidates.some((c) => c.move === "DELIVERY_FOR_PRICE")).toBe(false);
  });
});

describe("generateBuyerCandidates — all eligible candidates are generated at once (no short-circuiting)", () => {
  it("when both solo trades, the combined package, and the ordinary decision are ALL eligible, all four appear in the same candidate list", () => {
    // Milestone 12: openStrategy's fixture (deliveryFlexible, both chips
    // unused, a real price gap, leverage defined, quantity not already
    // short-supplied) satisfies the combined package's own eligibility
    // too — a fourth, genuinely independent candidate, not a
    // replacement for either solo trade.
    const candidates = generateBuyerCandidates(constraints, 46800, 50, ctx(3), openStrategy, maxDeliveryDays);
    expect(candidates).toHaveLength(4);
    // Exactly one ordinary candidate (HOLD or CONCEDE — whichever
    // decideBuyerConcessionMove picked this round), plus all three trades.
    expect(candidates.filter((c) => c.move === "HOLD" || c.move === "CONCEDE")).toHaveLength(1);
    expect(candidates.some((c) => c.move === "QUANTITY_FOR_PRICE")).toBe(true);
    expect(candidates.some((c) => c.move === "DELIVERY_FOR_PRICE")).toBe(true);
    expect(candidates.some((c) => c.move === "QUANTITY_AND_DELIVERY_FOR_PRICE")).toBe(true);
  });

  it("quantity trade being generated first in code does not automatically make it win — a cheaper ordinary/HOLD candidate still beats it", () => {
    // Hand-constructed only to isolate selectBestBuyerCandidate's own
    // comparison logic from candidate generation — see
    // orchestrator.test.ts's "Milestone 9" describe block for the
    // realistic, non-hand-constructed proof of the same property.
    const candidates: CandidateMove[] = [
      { move: "QUANTITY_FOR_PRICE", unitPrice: 45000, quantity: 100, reason: "trade" },
      { move: "HOLD", unitPrice: 44000, reason: "hold" }, // pushed AFTER the trade, yet cheaper
    ];
    expect(selectBestBuyerCandidate(candidates, constraints, 50, 10).move).toBe("HOLD");
  });

  it("delivery trade can win over quantity trade purely because it is cheaper, regardless of array order", () => {
    const quantityFirst: CandidateMove[] = [
      { move: "QUANTITY_FOR_PRICE", unitPrice: 45200, quantity: 100, reason: "q" },
      { move: "DELIVERY_FOR_PRICE", unitPrice: 44900, deliveryDays: 15, reason: "d" },
    ];
    const deliveryFirst: CandidateMove[] = [quantityFirst[1], quantityFirst[0]];
    expect(selectBestBuyerCandidate(quantityFirst, constraints, 50, 10).move).toBe("DELIVERY_FOR_PRICE");
    expect(selectBestBuyerCandidate(deliveryFirst, constraints, 50, 10).move).toBe("DELIVERY_FOR_PRICE");
  });

  it("quantity trade can equally win over delivery trade when it is the cheaper one, regardless of array order", () => {
    const arr: CandidateMove[] = [
      { move: "DELIVERY_FOR_PRICE", unitPrice: 45200, deliveryDays: 15, reason: "d" },
      { move: "QUANTITY_FOR_PRICE", unitPrice: 44900, quantity: 100, reason: "q" },
    ];
    expect(selectBestBuyerCandidate(arr, constraints, 50, 10).move).toBe("QUANTITY_FOR_PRICE");
    expect(selectBestBuyerCandidate([...arr].reverse(), constraints, 50, 10).move).toBe("QUANTITY_FOR_PRICE");
  });

  it("plain CONCEDE can win when neither trade is worthwhile (both absent this round)", () => {
    const arr: CandidateMove[] = [{ move: "CONCEDE", unitPrice: 45900, reason: "concede" }];
    expect(selectBestBuyerCandidate(arr, constraints, 50, 10).move).toBe("CONCEDE");
  });

  it("HOLD can win when it is genuinely the cheapest option available", () => {
    const arr: CandidateMove[] = [
      { move: "HOLD", unitPrice: 43500, reason: "hold" },
      { move: "QUANTITY_FOR_PRICE", unitPrice: 43900, quantity: 100, reason: "q" },
      { move: "DELIVERY_FOR_PRICE", unitPrice: 44100, deliveryDays: 15, reason: "d" },
    ];
    expect(selectBestBuyerCandidate(arr, constraints, 50, 10).move).toBe("HOLD");
  });
});

describe("generateBuyerCandidates — leverage is never an eligibility gate", () => {
  // Milestone 6's own lesson, re-verified at this layer: a trade
  // candidate's PRESENCE must not depend on leverage falling inside some
  // band. Sweeping leverage across its full range (weak to strong) with
  // every other situational condition held open confirms both trades
  // stay eligible throughout — leverage only ever affects the trade's
  // own price (a smaller ask at low leverage, a larger one at high),
  // never whether it appears in the candidate list at all.
  it.each([0, 20, 50, 75, 100])(
    "both trade candidates remain present at leverageScore=%d — only their price/ask size changes",
    (leverageScore) => {
      const candidates = generateBuyerCandidates(
        constraints,
        46800,
        50,
        ctx(3),
        { ...openStrategy, leverageScore },
        maxDeliveryDays,
      );
      expect(candidates.some((c) => c.move === "QUANTITY_FOR_PRICE")).toBe(true);
      expect(candidates.some((c) => c.move === "DELIVERY_FOR_PRICE")).toBe(true);
    },
  );

  it("the only leverage-driven exclusion is the documented TECHNICAL gate (leverage completely undefined) — not a strategic band", () => {
    const candidates = generateBuyerCandidates(
      constraints,
      46800,
      50,
      ctx(3),
      { ...openStrategy, leverageScore: undefined },
      maxDeliveryDays,
    );
    // Neither trade module has a leverage signal to size its ask with —
    // this is buyerQuantityTrade.ts's/buyerDeliveryTrade.ts's own
    // pre-existing, unchanged technical precondition (see their doc
    // comments), not a new eligibility band introduced by this milestone.
    expect(candidates.some((c) => c.move === "QUANTITY_FOR_PRICE")).toBe(false);
    expect(candidates.some((c) => c.move === "DELIVERY_FOR_PRICE")).toBe(false);
  });
});

describe("scoreBuyerCandidate / selectBestBuyerCandidate", () => {
  it("scores a candidate as exactly its own unitPrice (starting point: price is the buyer's dominant objective)", () => {
    const candidate: CandidateMove = { move: "CONCEDE", unitPrice: 45123, reason: "x" };
    expect(scoreBuyerCandidate(candidate)).toBe(45123);
  });

  it("selects the single lowest-priced candidate regardless of how many are supplied", () => {
    const candidates: CandidateMove[] = [
      { move: "CONCEDE", unitPrice: 45900, reason: "c" },
      { move: "QUANTITY_FOR_PRICE", unitPrice: 44200, quantity: 100, reason: "q" },
      { move: "DELIVERY_FOR_PRICE", unitPrice: 44800, deliveryDays: 15, reason: "d" },
    ];
    expect(selectBestBuyerCandidate(candidates, constraints, 50, 10).unitPrice).toBe(44200);
  });
});

// PACT V2 Milestone 11: package/deal-value comparison — direct unit
// tests of compareBuyerPackages itself (not just the pre-existing
// price-only cases above). See buyerMoveSelection.oldVsNew.test.ts for
// the separate, mandatory proof that this comparator is behaviorally
// equivalent to Milestone 9/10's price-only one across every candidate
// set the current codebase can actually produce.
describe("Milestone 11: compareBuyerPackages — lexicographic tiers", () => {
  // constraints.quantity is 50 (module-level, above) — a real shortfall
  // relative to it exercises evaluateQuantitySufficiency for real,
  // reusing that function verbatim, never duplicating its logic.
  it("an insufficient candidate loses to a sufficient one even though it is cheaper", () => {
    const insufficientButCheap: CandidateMove = {
      move: "CONCEDE",
      unitPrice: 44500, // cheaper...
      quantity: 30, // ...but a 40% shortfall against constraints.quantity (50), well beyond
      reason: "cheap-but-short",
    };
    const sufficientButPricier: CandidateMove = {
      move: "HOLD",
      unitPrice: 45500, // more expensive...
      quantity: 50, // ...but fully sufficient
      reason: "full-but-pricier",
    };
    const winner = selectBestBuyerCandidate(
      [insufficientButCheap, sufficientButPricier],
      constraints,
      30,
      10,
    );
    expect(winner).toBe(sufficientButPricier);

    // Confirms the shortfall really does land on INSUFFICIENT (not
    // INSUFFICIENT_PRICE_COMPENSATES) for this fixture, so the test is
    // actually exercising tier 1, not accidentally passing tier 3.
    expect(
      evaluateQuantitySufficiency(constraints, insufficientButCheap.quantity!, insufficientButCheap.unitPrice)
        .verdict,
    ).toBe("INSUFFICIENT");
  });

  it("equal sufficiency (both fully sufficient) falls through to price", () => {
    const a: CandidateMove = { move: "CONCEDE", unitPrice: 45200, quantity: 50, reason: "a" };
    const b: CandidateMove = { move: "HOLD", unitPrice: 44800, quantity: 50, reason: "b" };
    expect(selectBestBuyerCandidate([a, b], constraints, 50, 10)).toBe(b); // cheaper wins
    expect(selectBestBuyerCandidate([b, a], constraints, 50, 10)).toBe(b); // order-independent
  });

  it("equal sufficiency AND equal price falls through to delivery — faster wins", () => {
    const slower: CandidateMove = {
      move: "DELIVERY_FOR_PRICE",
      unitPrice: 44500,
      deliveryDays: 15,
      reason: "slower",
    };
    const faster: CandidateMove = { move: "HOLD", unitPrice: 44500, reason: "faster (implicit, via fallback)" };
    // faster's own deliveryDays is absent -> resolves to currentDeliveryDays (10), which beats slower's 15.
    expect(selectBestBuyerCandidate([slower, faster], constraints, 50, 10)).toBe(faster);
    expect(selectBestBuyerCandidate([faster, slower], constraints, 50, 10)).toBe(faster);
  });

  it("is deterministic — repeated calls on the same input produce the same winner", () => {
    const candidates: CandidateMove[] = [
      { move: "CONCEDE", unitPrice: 45200, quantity: 50, reason: "a" },
      { move: "HOLD", unitPrice: 44800, quantity: 50, reason: "b" },
      { move: "DELIVERY_FOR_PRICE", unitPrice: 44800, deliveryDays: 20, quantity: 50, reason: "c" },
    ];
    const first = selectBestBuyerCandidate(candidates, constraints, 50, 10);
    const second = selectBestBuyerCandidate(candidates, constraints, 50, 10);
    const third = selectBestBuyerCandidate([...candidates], constraints, 50, 10);
    expect(second).toBe(first);
    expect(third).toEqual(first);
  });

  it("never mutates the candidates it compares or selects among", () => {
    const candidates: CandidateMove[] = [
      { move: "CONCEDE", unitPrice: 45200, quantity: 40, reason: "a" },
      { move: "HOLD", unitPrice: 44800, quantity: 50, reason: "b" },
    ];
    const snapshot = JSON.parse(JSON.stringify(candidates));
    compareBuyerPackages(candidates[0], candidates[1], constraints, 50, 10);
    selectBestBuyerCandidate(candidates, constraints, 50, 10);
    expect(candidates).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------
// Pass 6: budgetFlexible consistency — effectiveCeiling now threads into
// all three trade generators, not just the ordinary candidate.
// ---------------------------------------------------------------------
describe("generateBuyerCandidates — Pass 6: effectiveCeiling reaches the trade candidates too", () => {
  // No previousBuyerUnitPrice, so each trade's own upperBound is exactly
  // effectiveCeiling (see buyerQuantityTrade.test.ts's own Pass 6 tests
  // for why this isolates the effect cleanly).
  const openNoPreviousPrice: BuyerCandidateStrategyContext = {
    priorMerchantUnitPrice: 47000,
    previousBuyerUnitPrice: undefined,
    leverageScore: 60,
    quantityTradeAlreadyUsed: false,
    deliveryTradeAlreadyUsed: false,
  };

  it("a higher effectiveCeiling raises the QUANTITY_FOR_PRICE candidate's price above the hard maxUnitPrice", () => {
    const hard = generateBuyerCandidates(constraints, 200000, 50, ctx(3), openNoPreviousPrice, maxDeliveryDays);
    const flexible = generateBuyerCandidates(constraints, 200000, 50, ctx(3), openNoPreviousPrice, maxDeliveryDays, 100000);

    const hardTrade = hard.find((c) => c.move === "QUANTITY_FOR_PRICE");
    const flexibleTrade = flexible.find((c) => c.move === "QUANTITY_FOR_PRICE");
    expect(hardTrade).toBeDefined();
    expect(flexibleTrade).toBeDefined();
    expect(hardTrade!.unitPrice).toBeLessThanOrEqual(constraints.maxUnitPrice);
    expect(flexibleTrade!.unitPrice).toBeLessThanOrEqual(100000);
    expect(flexibleTrade!.unitPrice).toBeGreaterThan(hardTrade!.unitPrice);
  });

  it("a higher effectiveCeiling raises the DELIVERY_FOR_PRICE candidate's price above the hard maxUnitPrice", () => {
    const hard = generateBuyerCandidates(constraints, 200000, 50, ctx(3), openNoPreviousPrice, maxDeliveryDays);
    const flexible = generateBuyerCandidates(constraints, 200000, 50, ctx(3), openNoPreviousPrice, maxDeliveryDays, 100000);

    const hardTrade = hard.find((c) => c.move === "DELIVERY_FOR_PRICE");
    const flexibleTrade = flexible.find((c) => c.move === "DELIVERY_FOR_PRICE");
    expect(hardTrade).toBeDefined();
    expect(flexibleTrade).toBeDefined();
    expect(hardTrade!.unitPrice).toBeLessThanOrEqual(constraints.maxUnitPrice);
    expect(flexibleTrade!.unitPrice).toBeLessThanOrEqual(100000);
    expect(flexibleTrade!.unitPrice).toBeGreaterThan(hardTrade!.unitPrice);
  });

  it("omitting effectiveCeiling entirely reproduces the exact pre-Pass-6 candidate set", () => {
    const withoutParam = generateBuyerCandidates(constraints, 46800, 50, ctx(3), openStrategy, maxDeliveryDays);
    const withExplicitMax = generateBuyerCandidates(
      constraints,
      46800,
      50,
      ctx(3),
      openStrategy,
      maxDeliveryDays,
      constraints.maxUnitPrice,
    );
    expect(withExplicitMax).toEqual(withoutParam);
  });
});
