import { describe, expect, it } from "vitest";
import { decideBuyerQuantityAndDeliveryTrade } from "./buyerQuantityAndDeliveryTrade";
import { resolveQuantityTradeIncreaseFraction } from "./negotiationStrategy";
import type { BuyerConcessionContext, BuyerConstraints } from "@/lib/rules/buyerRules";

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

// The computed delivery give below is 10 + round(10*0.5) = 15. 20 is
// deliberately well above that, so every existing test in this file
// exercises the "computed <= maxDeliveryDays, behavior unchanged" case
// (Milestone hardening req. 5) — the clamp itself is covered separately,
// in its own describe block below.
const maxDeliveryDays = 20;

describe("decideBuyerQuantityAndDeliveryTrade — eligibility (intersection of both solo gates)", () => {
  it("fires when every precondition holds", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), null, 60, false, false, maxDeliveryDays);
    expect(decision.move).toBe("QUANTITY_AND_DELIVERY_FOR_PRICE");
    expect(decision.quantity).not.toBeNull();
    expect(decision.deliveryDays).not.toBeNull();
    expect(decision.unitPrice).not.toBeNull();
  });

  it("requires delivery flexibility — never fires without it", () => {
    const inflexible: BuyerConstraints = { ...constraints, deliveryFlexible: false };
    const decision = decideBuyerQuantityAndDeliveryTrade(inflexible, 46800, 50, ctx(3), null, 60, false, false, maxDeliveryDays);
    expect(decision.move).toBe("NO_TRADE");
    expect(decision.quantity).toBeNull();
    expect(decision.deliveryDays).toBeNull();
    expect(decision.unitPrice).toBeNull();
  });

  it("requires rounds remain beyond the final-two-round safety net", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(7, 8), null, 60, false, false, maxDeliveryDays);
    expect(decision.move).toBe("NO_TRADE");
  });

  it("BOTH chips must be unused — the quantity chip alone being used blocks it", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), null, 60, true, false, maxDeliveryDays);
    expect(decision.move).toBe("NO_TRADE");
  });

  it("BOTH chips must be unused — the delivery chip alone being used blocks it", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), null, 60, false, true, maxDeliveryDays);
    expect(decision.move).toBe("NO_TRADE");
  });

  it("BOTH chips already used blocks it too", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), null, 60, true, true, maxDeliveryDays);
    expect(decision.move).toBe("NO_TRADE");
  });

  // Milestone 12 section 11/16: partial fulfillment must never combine
  // with a quantity increase — the SAME precondition the solo quantity
  // trade already has, reused verbatim, not a new rule.
  it("partial fulfillment (merchant already short-supplying the original request) blocks the combined move", () => {
    const merchantOfferedQuantity = 40; // short of constraints.quantity (50)
    const decision = decideBuyerQuantityAndDeliveryTrade(
      constraints,
      46800,
      merchantOfferedQuantity,
      ctx(3),
      null,
      60,
      false,
      false,
      maxDeliveryDays,
    );
    expect(decision.move).toBe("NO_TRADE");
    expect(decision.reason).toContain("already unable to fully supply");
  });

  it("requires a real price gap — no trade when the merchant's offer already meets the buyer's target", () => {
    // resolveBuyerTarget(constraints) with no leverage = round(46000*0.95) = 43700
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 43700, 50, ctx(3), null, 60, false, false, maxDeliveryDays);
    expect(decision.move).toBe("NO_TRADE");
  });

  it("requires a leverage signal (technical gate, not a strategic exclusion)", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), null, undefined, false, false, maxDeliveryDays);
    expect(decision.move).toBe("NO_TRADE");
    expect(decision.reason).toContain("No buyer leverage signal");
  });
});

describe("decideBuyerQuantityAndDeliveryTrade — sizing reuses the same resolvers as the solo quantity trade (redesign)", () => {
  it("J: quantity give matches resolveQuantityTradeIncreaseFraction exactly — the SAME resolver the solo trade uses, not a second formula", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), null, 60, false, false, maxDeliveryDays);
    // Verified live (Buyer Quantity-for-Price Redesign) — never hand-derived.
    expect(decision.quantity).toBe(57);
    const askMultiplier = 0.5 + 60 / 100; // resolveLeverageAskMultiplier(60), reused directly to cross-check
    const expectedFraction = resolveQuantityTradeIncreaseFraction(constraints.maxUnitPrice, constraints.quantity, askMultiplier);
    expect(decision.quantity).toBe(Math.round(constraints.quantity * (1 + expectedFraction)));
  });

  it("delivery give matches DELIVERY_TRADE_EXTENSION_FRACTION exactly (unchanged — delivery math is explicitly out of scope for this redesign)", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), null, 60, false, false, maxDeliveryDays);
    expect(decision.deliveryDays).toBe(15); // 10 + round(10 * 0.5), identical to buyerDeliveryTrade.ts's own formula
  });

  it("J: the combined price never exceeds previousBuyerUnitPrice when one exists, and is bounded to [target, maxUnitPrice]", () => {
    const withoutCeiling = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), null, 60, false, false, maxDeliveryDays);
    const withCeiling = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 44000, 60, false, false, maxDeliveryDays);
    expect(withoutCeiling.move).toBe("QUANTITY_AND_DELIVERY_FOR_PRICE");
    // 44000 comfortably clears the natural (uncapped) price here, so the
    // ceiling is a no-op on this fixture — both resolve identically.
    // Verified live.
    expect(withCeiling.unitPrice).toBe(withoutCeiling.unitPrice);
    expect(withoutCeiling.unitPrice!).toBeGreaterThanOrEqual(43700); // target
    expect(withoutCeiling.unitPrice!).toBeLessThanOrEqual(constraints.maxUnitPrice);
  });

  // J. A real case where the ceiling DOES actively bind, correctly
  // producing NO_TRADE rather than a trade priced worse than the buyer's
  // own last offer — real numbers, verified live.
  it("J: NO_TRADE when previousBuyerUnitPrice leaves no meaningful (>=0.5%) improvement over the natural price", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 43900, 20, false, false, maxDeliveryDays);
    expect(decision.move).toBe("NO_TRADE");
    expect(decision.reason).toContain("not a meaningful improvement");
  });
});

describe("decideBuyerQuantityAndDeliveryTrade — clamping and determinism", () => {
  it("never exceeds the buyer's maxUnitPrice, even against a very high merchant offer", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 200000, 50, ctx(3), null, 100, false, false, maxDeliveryDays);
    if (decision.move === "QUANTITY_AND_DELIVERY_FOR_PRICE") {
      expect(decision.unitPrice!).toBeLessThanOrEqual(constraints.maxUnitPrice);
    }
  });

  it("never goes below the buyer's own aspirational target", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), null, 100, false, false, maxDeliveryDays);
    // resolveBuyerTarget(constraints) = 43700 (no leverage-driven quantity discount at 50 units)
    if (decision.move === "QUANTITY_AND_DELIVERY_FOR_PRICE") {
      expect(decision.unitPrice!).toBeGreaterThanOrEqual(43700);
    }
  });

  it("is deterministic — repeated calls with identical inputs produce identical output", () => {
    const first = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), null, 60, false, false, maxDeliveryDays);
    const second = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), null, 60, false, false, maxDeliveryDays);
    expect(second).toEqual(first);
  });

  it("the reason string explicitly describes the conditional give-both-for-price semantics", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), null, 60, false, false, maxDeliveryDays);
    expect(decision.reason).toContain("increase the order to 57 units");
    expect(decision.reason).toContain("accept delivery in 15 days");
    expect(decision.reason).toContain("in exchange for a better unit price");
  });
});

// ---------------------------------------------------------------------
// PACT — Buyer delivery-trade ceiling fix (negotiation hardening audit,
// finding D: the combined trade's delivery component must obey exactly
// the same ceiling as the solo trade). Focused regression test, per that
// task's own required case D. Untouched by the quantity-for-price
// redesign — the delivery-ceiling gate runs BEFORE quantity/price
// sizing, so its own NO_TRADE outcome is unaffected by any formula
// change on the quantity/price side.
// ---------------------------------------------------------------------
describe("decideBuyerQuantityAndDeliveryTrade — maxDeliveryDays ceiling (negotiation hardening fix)", () => {
  // D. combined trade also obeys the ceiling.
  it("D: deadline=12, maxDeliveryDays=12 — the delivery component never proposes 18, and the combined move correctly does not fire", () => {
    const atCeiling: BuyerConstraints = { ...constraints, deliveryDeadlineDays: 12 };
    const decision = decideBuyerQuantityAndDeliveryTrade(atCeiling, 46800, 50, ctx(3), null, 60, false, false, 12);
    expect(decision.deliveryDays).not.toBe(18);
    // 12 + round(12*0.5) = 18, clamped to 12 == the buyer's own deadline
    // -> no real delivery give left -> the combined move is not a valid
    // give-both-for-price at all (never silently degrades to a
    // quantity-only trade under this move's own name).
    expect(decision.move).toBe("NO_TRADE");
    expect(decision.reason).toContain("maximum delivery window");
    expect(decision.quantity).toBeNull();
  });

  it("a tighter ceiling than the solo trade's own clamps the combined delivery give identically (deadline=7, max=10)", () => {
    const tight: BuyerConstraints = { ...constraints, deliveryDeadlineDays: 7 };
    const decision = decideBuyerQuantityAndDeliveryTrade(tight, 46800, 50, ctx(3), null, 60, false, false, 10);
    expect(decision.move).toBe("QUANTITY_AND_DELIVERY_FOR_PRICE");
    expect(decision.deliveryDays).toBe(10); // 7 + round(7*0.5) = 11, clamped to 10
    // Quantity sizing is unaffected by deliveryDeadlineDays — the resolver
    // reads only maxUnitPrice/quantity/leverage — so it matches the SAME
    // fixture's own sizing test above (57), unchanged from that scenario.
    expect(decision.quantity).toBe(57);
  });
});

// ---------------------------------------------------------------------
// PACT — Urgency-calibrated delivery flexibility (negotiation
// calibration task). The combined trade's delivery component must use
// EXACTLY the same resolveDeliveryUrgencyFactor policy as the solo
// delivery trade — see buyerDeliveryTrade.test.ts for the equivalent
// solo-trade coverage (A/B/C/G/I); this block covers what's specific to
// the combined move (D, F, H). Untouched by the quantity-for-price
// redesign on the delivery side; H's own quantity value is updated to
// reflect the new resolver.
// ---------------------------------------------------------------------
describe("decideBuyerQuantityAndDeliveryTrade — urgency-calibrated delivery extension", () => {
  const comfortable: Omit<BuyerConstraints, "urgency"> = { ...constraints, deliveryDeadlineDays: 6 };

  // D. deadline == maxDeliveryDays -> NO_TRADE for LOW/MEDIUM/HIGH alike,
  // for the combined move too (not just the solo trade).
  it("D: deadline == maxDeliveryDays produces NO_TRADE for every urgency level", () => {
    for (const urgency of ["low", "medium", "high"] as const) {
      const atCeiling: BuyerConstraints = { ...comfortable, deliveryDeadlineDays: 12, urgency };
      const decision = decideBuyerQuantityAndDeliveryTrade(atCeiling, 46800, 50, ctx(3), null, 60, false, false, 12);
      expect(decision.move).toBe("NO_TRADE");
      expect(decision.quantity).toBeNull();
      expect(decision.deliveryDays).toBeNull();
    }
  });

  // F. Solo and combined delivery calculations use the same urgency
  // policy — direct cross-function comparison at identical inputs.
  it("F: the combined trade's deliveryDays matches the solo delivery trade's own, at every urgency level", async () => {
    const { decideBuyerDeliveryTrade } = await import("./buyerDeliveryTrade");
    for (const urgency of ["low", "medium", "high"] as const) {
      const withUrgency: BuyerConstraints = { ...comfortable, urgency };
      const solo = decideBuyerDeliveryTrade(withUrgency, 46800, ctx(3), undefined, 60, false, 12);
      const combined = decideBuyerQuantityAndDeliveryTrade(withUrgency, 46800, 50, ctx(3), null, 60, false, false, 12);
      expect(combined.deliveryDays).toBe(solo.deliveryDays);
    }
  });

  // H. Quantity sizing is completely unaffected by the urgency-delivery
  // factor — only deliveryDays (never quantity) changes across urgency.
  it("H: quantity sizing is identical across LOW/MEDIUM/HIGH — only deliveryDays changes", () => {
    const low = decideBuyerQuantityAndDeliveryTrade({ ...comfortable, urgency: "low" }, 46800, 50, ctx(3), null, 60, false, false, 12);
    const medium = decideBuyerQuantityAndDeliveryTrade({ ...comfortable, urgency: "medium" }, 46800, 50, ctx(3), null, 60, false, false, 12);
    const high = decideBuyerQuantityAndDeliveryTrade({ ...comfortable, urgency: "high" }, 46800, 50, ctx(3), null, 60, false, false, 12);
    // resolveQuantityTradeIncreaseFraction reads only maxUnitPrice/quantity/
    // leverage — never urgency — so all three land on the identical
    // quantity, matching the fixture's own sizing test above (57).
    expect(low.quantity).toBe(57);
    expect(medium.quantity).toBe(57);
    expect(high.quantity).toBe(57);
    // ...but deliveryDays genuinely differs, confirming the sweep is real.
    expect(low.deliveryDays).toBe(10); // 6 + round(6*0.7)
    expect(medium.deliveryDays).toBe(9); // 6 + round(6*0.5) — the baseline
    expect(high.deliveryDays).toBe(8); // 6 + round(6*0.3)
  });
});

// ---------------------------------------------------------------------
// Pass 6: budgetFlexible consistency — effectiveCeiling threading.
// ---------------------------------------------------------------------
describe("decideBuyerQuantityAndDeliveryTrade — Pass 6: effectiveCeiling", () => {
  // E. Hard budget (effectiveCeiling omitted, or explicitly equal to
  // maxUnitPrice) reproduces byte-identical behavior.
  it("E: omitting effectiveCeiling and passing it equal to maxUnitPrice produce identical results", () => {
    const omitted = decideBuyerQuantityAndDeliveryTrade(constraints, 200000, 50, ctx(3), null, 60, false, false, maxDeliveryDays);
    const explicitMax = decideBuyerQuantityAndDeliveryTrade(
      constraints,
      200000,
      50,
      ctx(3),
      null,
      60,
      false,
      false,
      maxDeliveryDays,
      constraints.maxUnitPrice,
    );
    expect(explicitMax).toEqual(omitted);
  });

  // D. A flexible buyer's combined trade can reach a higher
  // effectiveCeiling than its stated maxUnitPrice — same saturation
  // technique as the two solo trades' own Pass 6 tests.
  it("D: a higher effectiveCeiling raises the combined trade's own price ceiling above the hard maxUnitPrice", () => {
    // Deliberately a very generous ceiling (not just barely above
    // maxUnitPrice): the combined trade composes TWO sequential
    // discounts (quantity then delivery), so a modestly higher ceiling
    // can still discount back down to the same target-floor as the hard
    // case — a large margin makes the comparison robust regardless of
    // the exact discount-fraction math.
    const flexibleCeiling = 100000; // well above constraints.maxUnitPrice (46000)
    const hard = decideBuyerQuantityAndDeliveryTrade(constraints, 200000, 50, ctx(3), null, 60, false, false, maxDeliveryDays);
    const flexible = decideBuyerQuantityAndDeliveryTrade(
      constraints,
      200000,
      50,
      ctx(3),
      null,
      60,
      false,
      false,
      maxDeliveryDays,
      flexibleCeiling,
    );
    expect(hard.move).toBe("QUANTITY_AND_DELIVERY_FOR_PRICE");
    expect(flexible.move).toBe("QUANTITY_AND_DELIVERY_FOR_PRICE");
    expect(hard.unitPrice!).toBeLessThanOrEqual(constraints.maxUnitPrice);
    expect(flexible.unitPrice!).toBeLessThanOrEqual(flexibleCeiling);
    expect(flexible.unitPrice!).toBeGreaterThan(hard.unitPrice!);
  });

  it("D: still respects previousBuyerUnitPrice as the tighter of the two bounds, even when effectiveCeiling is higher", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(
      constraints,
      200000,
      50,
      ctx(3),
      47200, // the buyer's own prior offer — below the flexible ceiling
      60,
      false,
      false,
      maxDeliveryDays,
      52000,
    );
    if (decision.move === "QUANTITY_AND_DELIVERY_FOR_PRICE") {
      expect(decision.unitPrice!).toBeLessThanOrEqual(47200);
    }
  });
});
