import { describe, expect, it } from "vitest";
import type { BuyerConcessionContext, BuyerConstraints } from "@/lib/rules/buyerRules";
import {
  generateBuyerCandidates,
  scoreBuyerCandidate,
  selectBestBuyerCandidate,
  type BuyerCandidateStrategyContext,
} from "./buyerMoveSelection";
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

describe("generateBuyerCandidates — adapters map existing decisions correctly", () => {
  it("the ordinary decision (decideBuyerConcessionMove) always adapts into the first candidate, whatever move it picked", () => {
    const candidates = generateBuyerCandidates(constraints, 46800, 50, ctx(3), openStrategy);
    expect(candidates[0].move === "HOLD" || candidates[0].move === "CONCEDE").toBe(true);
    expect(candidates[0].unitPrice).toBeGreaterThan(0);
    expect(candidates[0].quantity).toBeUndefined();
    expect(candidates[0].deliveryDays).toBeUndefined();
    expect(typeof candidates[0].reason).toBe("string");
    expect(candidates[0].reason.length).toBeGreaterThan(0);
  });

  it("a firing quantity trade (decideBuyerQuantityTrade) adapts its quantity/unitPrice/reason verbatim into a QUANTITY_FOR_PRICE candidate", () => {
    const candidates = generateBuyerCandidates(constraints, 46800, 50, ctx(3), openStrategy);
    const trade = candidates.find((c) => c.move === "QUANTITY_FOR_PRICE");
    expect(trade).toBeDefined();
    expect(trade!.quantity).toBe(100); // constraints.quantity * (1 + QUANTITY_TRADE_INCREASE_FRACTION)
    expect(trade!.deliveryDays).toBeUndefined();
    expect(trade!.reason).toContain("increase the order to 100 units");
  });

  it("a firing delivery trade (decideBuyerDeliveryTrade) adapts its deliveryDays/unitPrice/reason verbatim into a DELIVERY_FOR_PRICE candidate", () => {
    const candidates = generateBuyerCandidates(constraints, 46800, 50, ctx(3), openStrategy);
    const trade = candidates.find((c) => c.move === "DELIVERY_FOR_PRICE");
    expect(trade).toBeDefined();
    expect(trade!.deliveryDays).toBe(15); // 10 + round(10 * 0.5)
    expect(trade!.quantity).toBeUndefined();
    expect(trade!.reason).toContain("accept delivery in 15 days");
  });

  it("a NO_TRADE verdict from either module never produces a candidate for that dimension", () => {
    // deliveryFlexible false -> decideBuyerDeliveryTrade always returns NO_TRADE.
    const inflexible: BuyerConstraints = { ...constraints, deliveryFlexible: false };
    const candidates = generateBuyerCandidates(inflexible, 46800, 50, ctx(3), openStrategy);
    expect(candidates.some((c) => c.move === "DELIVERY_FOR_PRICE")).toBe(false);
  });
});

describe("generateBuyerCandidates — all eligible candidates are generated at once (no short-circuiting)", () => {
  it("when both trades and the ordinary decision are eligible, all three appear in the same candidate list", () => {
    const candidates = generateBuyerCandidates(constraints, 46800, 50, ctx(3), openStrategy);
    expect(candidates).toHaveLength(3);
    // Exactly one ordinary candidate (HOLD or CONCEDE — whichever
    // decideBuyerConcessionMove picked this round), plus both trades.
    expect(candidates.filter((c) => c.move === "HOLD" || c.move === "CONCEDE")).toHaveLength(1);
    expect(candidates.some((c) => c.move === "QUANTITY_FOR_PRICE")).toBe(true);
    expect(candidates.some((c) => c.move === "DELIVERY_FOR_PRICE")).toBe(true);
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
    expect(selectBestBuyerCandidate(candidates).move).toBe("HOLD");
  });

  it("delivery trade can win over quantity trade purely because it is cheaper, regardless of array order", () => {
    const quantityFirst: CandidateMove[] = [
      { move: "QUANTITY_FOR_PRICE", unitPrice: 45200, quantity: 100, reason: "q" },
      { move: "DELIVERY_FOR_PRICE", unitPrice: 44900, deliveryDays: 15, reason: "d" },
    ];
    const deliveryFirst: CandidateMove[] = [quantityFirst[1], quantityFirst[0]];
    expect(selectBestBuyerCandidate(quantityFirst).move).toBe("DELIVERY_FOR_PRICE");
    expect(selectBestBuyerCandidate(deliveryFirst).move).toBe("DELIVERY_FOR_PRICE");
  });

  it("quantity trade can equally win over delivery trade when it is the cheaper one, regardless of array order", () => {
    const arr: CandidateMove[] = [
      { move: "DELIVERY_FOR_PRICE", unitPrice: 45200, deliveryDays: 15, reason: "d" },
      { move: "QUANTITY_FOR_PRICE", unitPrice: 44900, quantity: 100, reason: "q" },
    ];
    expect(selectBestBuyerCandidate(arr).move).toBe("QUANTITY_FOR_PRICE");
    expect(selectBestBuyerCandidate([...arr].reverse()).move).toBe("QUANTITY_FOR_PRICE");
  });

  it("plain CONCEDE can win when neither trade is worthwhile (both absent this round)", () => {
    const arr: CandidateMove[] = [{ move: "CONCEDE", unitPrice: 45900, reason: "concede" }];
    expect(selectBestBuyerCandidate(arr).move).toBe("CONCEDE");
  });

  it("HOLD can win when it is genuinely the cheapest option available", () => {
    const arr: CandidateMove[] = [
      { move: "HOLD", unitPrice: 43500, reason: "hold" },
      { move: "QUANTITY_FOR_PRICE", unitPrice: 43900, quantity: 100, reason: "q" },
      { move: "DELIVERY_FOR_PRICE", unitPrice: 44100, deliveryDays: 15, reason: "d" },
    ];
    expect(selectBestBuyerCandidate(arr).move).toBe("HOLD");
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
      const candidates = generateBuyerCandidates(constraints, 46800, 50, ctx(3), {
        ...openStrategy,
        leverageScore,
      });
      expect(candidates.some((c) => c.move === "QUANTITY_FOR_PRICE")).toBe(true);
      expect(candidates.some((c) => c.move === "DELIVERY_FOR_PRICE")).toBe(true);
    },
  );

  it("the only leverage-driven exclusion is the documented TECHNICAL gate (leverage completely undefined) — not a strategic band", () => {
    const candidates = generateBuyerCandidates(constraints, 46800, 50, ctx(3), {
      ...openStrategy,
      leverageScore: undefined,
    });
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
    expect(selectBestBuyerCandidate(candidates).unitPrice).toBe(44200);
  });
});
