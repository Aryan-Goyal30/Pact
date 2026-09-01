import { describe, expect, it } from "vitest";
import { decideBuyerConcessionMove } from "./buyerMoveSelector";
import type { BuyerConcessionContext, BuyerConstraints } from "@/lib/rules/buyerRules";

const constraints: BuyerConstraints = {
  sku: "LAPTOP-14-I5",
  quantity: 10,
  maxUnitPrice: 46000,
  deliveryDeadlineDays: 10,
};

function ctx(round: number, maxRounds = 8): BuyerConcessionContext {
  return { round, maxRounds };
}

describe("decideBuyerConcessionMove — final rounds always concede (unchanged safety net)", () => {
  it("concedes to the true ceiling once only 2 rounds remain, regardless of merchant movement or leverage", () => {
    const decision = decideBuyerConcessionMove(constraints, 47000, ctx(7, 8), 47500, 44000, 90);
    expect(decision.move).toBe("CONCEDE");
    expect(decision.unitPrice).toBe(constraints.maxUnitPrice);
  });
});

describe("decideBuyerConcessionMove — A: Buyer can HOLD", () => {
  it("holds at its own previous price when the merchant hasn't moved", () => {
    const decision = decideBuyerConcessionMove(
      constraints,
      47000, // merchant's current offer
      ctx(3, 8),
      47000, // priorMerchantUnitPrice — identical to current: merchant did NOT move
      44000, // previousBuyerUnitPrice
      undefined,
    );
    expect(decision.move).toBe("HOLD");
    expect(decision.unitPrice).toBe(44000);
  });

  it("holds when leverage is strong, even if the merchant did move a little", () => {
    const decision = decideBuyerConcessionMove(
      constraints,
      46800, // improved from 47500
      ctx(3, 8),
      47500,
      44000,
      75, // strong leverage
    );
    expect(decision.move).toBe("HOLD");
    expect(decision.unitPrice).toBe(44000);
  });
});

describe("decideBuyerConcessionMove — B: Buyer can CONCEDE", () => {
  it("concedes when the merchant moved and leverage is neutral/unset", () => {
    const decision = decideBuyerConcessionMove(constraints, 46800, ctx(3, 8), 47500, 44000, undefined);
    expect(decision.move).toBe("CONCEDE");
    expect(decision.unitPrice).toBeGreaterThan(44000);
    expect(decision.unitPrice).toBeLessThanOrEqual(constraints.maxUnitPrice);
  });

  it("concedes even when the merchant hasn't moved, if leverage is weak", () => {
    const decision = decideBuyerConcessionMove(
      constraints,
      47000,
      ctx(3, 8),
      47000, // merchant did NOT move
      44000,
      20, // weak leverage — protecting the deal matters more than testing firmness
    );
    expect(decision.move).toBe("CONCEDE");
  });
});

describe("decideBuyerConcessionMove — D: never exceeds maxUnitPrice", () => {
  it("CONCEDE is always clamped to maxUnitPrice, even against a very high merchant offer", () => {
    const decision = decideBuyerConcessionMove(constraints, 200000, ctx(3, 8), 210000, 44000, 20);
    expect(decision.unitPrice).toBeLessThanOrEqual(constraints.maxUnitPrice);
  });

  it("HOLD never exceeds maxUnitPrice (repeats a previous price that was itself already clamped)", () => {
    const decision = decideBuyerConcessionMove(constraints, 47000, ctx(3, 8), 47000, 45500, undefined);
    expect(decision.unitPrice).toBeLessThanOrEqual(constraints.maxUnitPrice);
  });
});

describe("decideBuyerConcessionMove — E: reacts differently to merchant movement, same buyer state otherwise", () => {
  it("merchant moved vs merchant did not move produces a different move for identical buyer state", () => {
    const merchantMoved = decideBuyerConcessionMove(constraints, 46800, ctx(3, 8), 47500, 44000, undefined);
    const merchantStalled = decideBuyerConcessionMove(constraints, 47000, ctx(3, 8), 47000, 44000, undefined);

    expect(merchantMoved.move).toBe("CONCEDE");
    expect(merchantStalled.move).toBe("HOLD");
  });
});

describe("decideBuyerConcessionMove — F: leverage influence, bounded", () => {
  it("higher leverage shifts the decision toward HOLD for the same merchant/round state", () => {
    const lowLeverage = decideBuyerConcessionMove(constraints, 46900, ctx(3, 8), 47500, 44000, 20);
    const highLeverage = decideBuyerConcessionMove(constraints, 46900, ctx(3, 8), 47500, 44000, 80);

    expect(lowLeverage.move).toBe("CONCEDE");
    expect(highLeverage.move).toBe("HOLD");
    // Bounded: whichever move is chosen, price never exceeds the ceiling.
    expect(lowLeverage.unitPrice).toBeLessThanOrEqual(constraints.maxUnitPrice);
    expect(highLeverage.unitPrice).toBeLessThanOrEqual(constraints.maxUnitPrice);
  });

  it("omitting leverage entirely reproduces the merchant-movement-only decision", () => {
    const withoutLeverage = decideBuyerConcessionMove(constraints, 46800, ctx(3, 8), 47500, 44000, undefined);
    expect(withoutLeverage.move).toBe("CONCEDE");
  });
});

describe("decideBuyerConcessionMove — no prior merchant history (buyer's first real counter)", () => {
  it("treats missing prior-merchant data as 'merchant moved' — concedes as before this milestone existed", () => {
    const decision = decideBuyerConcessionMove(constraints, 47000, ctx(2, 8), null, 45000, undefined);
    expect(decision.move).toBe("CONCEDE");
  });

  it("falls back to the buyer's own target when holding with no previous buyer price available", () => {
    const decision = decideBuyerConcessionMove(constraints, 47000, ctx(3, 8), 47000, null, 90);
    expect(decision.move).toBe("HOLD");
    expect(decision.unitPrice).toBeGreaterThan(0);
    expect(decision.unitPrice).toBeLessThanOrEqual(constraints.maxUnitPrice);
  });
});

// Negotiation Engine V2 (D1/D2): leverage now also causally affects the
// CONCEDE branch's own PRICE, not just the HOLD-vs-CONCEDE threshold —
// this is the actual integration point (buyerMoveSelector.ts wiring
// buyerRules.computeBuyerConcessionPrice's new leverageSpeedFactor
// parameter) proved here, distinct from the formula-level tests in
// buyerRules.test.ts.
describe("decideBuyerConcessionMove — G: leverage is causal for the CONCEDE price itself (D1/D2)", () => {
  it("weaker buyer leverage produces a HIGHER concede price than stronger buyer leverage, same merchant offer/history otherwise", () => {
    // Both stay in the CONCEDE branch (moderate leverage, well clear of
    // the HOLD_LEVERAGE_THRESHOLD=60 boundary) — isolates the price
    // effect from the branch-selection effect already covered by F above.
    const weakBuyer = decideBuyerConcessionMove(constraints, 46800, ctx(3, 8), 47500, 44000, 20);
    const strongerBuyer = decideBuyerConcessionMove(constraints, 46800, ctx(3, 8), 47500, 44000, 45);
    expect(weakBuyer.move).toBe("CONCEDE");
    expect(strongerBuyer.move).toBe("CONCEDE");
    expect(weakBuyer.unitPrice).toBeGreaterThan(strongerBuyer.unitPrice);
  });
});

// Test requirement E (history/opponent movement matters): a side that
// has already conceded (merchant's price genuinely dropped) behaves
// differently from one that has not (merchant repeated the same price),
// all else — including leverage — held equal. Complements section E
// above (which proves the move flips HOLD/CONCEDE); this proves the
// SAME underlying history signal survives, unaffected, now that leverage
// is also in the mix.
describe("decideBuyerConcessionMove — history/opponent movement still matters with leverage in the mix", () => {
  it("identical leverage, only the merchant's movement history differs, still produces a different move", () => {
    const afterMerchantMoved = decideBuyerConcessionMove(constraints, 46800, ctx(3, 8), 47500, 44000, 50);
    const afterMerchantStalled = decideBuyerConcessionMove(constraints, 47000, ctx(3, 8), 47000, 44000, 50);
    expect(afterMerchantMoved.move).toBe("CONCEDE");
    expect(afterMerchantStalled.move).toBe("HOLD");
  });
});
