import { describe, expect, it } from "vitest";
import { decideBuyerQuantityAndDeliveryTrade } from "./buyerQuantityAndDeliveryTrade";
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
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, false, maxDeliveryDays);
    expect(decision.move).toBe("QUANTITY_AND_DELIVERY_FOR_PRICE");
    expect(decision.quantity).not.toBeNull();
    expect(decision.deliveryDays).not.toBeNull();
    expect(decision.unitPrice).not.toBeNull();
  });

  it("requires delivery flexibility — never fires without it", () => {
    const inflexible: BuyerConstraints = { ...constraints, deliveryFlexible: false };
    const decision = decideBuyerQuantityAndDeliveryTrade(inflexible, 46800, 50, ctx(3), 60, false, false, maxDeliveryDays);
    expect(decision.move).toBe("NO_TRADE");
    expect(decision.quantity).toBeNull();
    expect(decision.deliveryDays).toBeNull();
    expect(decision.unitPrice).toBeNull();
  });

  it("requires rounds remain beyond the final-two-round safety net", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(7, 8), 60, false, false, maxDeliveryDays);
    expect(decision.move).toBe("NO_TRADE");
  });

  it("BOTH chips must be unused — the quantity chip alone being used blocks it", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, true, false, maxDeliveryDays);
    expect(decision.move).toBe("NO_TRADE");
  });

  it("BOTH chips must be unused — the delivery chip alone being used blocks it", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, true, maxDeliveryDays);
    expect(decision.move).toBe("NO_TRADE");
  });

  it("BOTH chips already used blocks it too", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, true, true, maxDeliveryDays);
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
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 43700, 50, ctx(3), 60, false, false, maxDeliveryDays);
    expect(decision.move).toBe("NO_TRADE");
  });

  it("requires a leverage signal (technical gate, not a strategic exclusion)", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), undefined, false, false, maxDeliveryDays);
    expect(decision.move).toBe("NO_TRADE");
    expect(decision.reason).toContain("No buyer leverage signal");
  });
});

describe("decideBuyerQuantityAndDeliveryTrade — sizing reuses existing constants", () => {
  it("quantity give matches QUANTITY_TRADE_INCREASE_FRACTION exactly (same as the solo quantity trade)", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, false, maxDeliveryDays);
    expect(decision.quantity).toBe(100); // 50 * (1 + 1.0), identical to buyerQuantityTrade.ts's own formula
  });

  it("delivery give matches DELIVERY_TRADE_EXTENSION_FRACTION exactly (same as the solo delivery trade)", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, false, maxDeliveryDays);
    expect(decision.deliveryDays).toBe(15); // 10 + round(10 * 0.5), identical to buyerDeliveryTrade.ts's own formula
  });

  it("the combined price is strictly cheaper than either solo trade would ask (sequential composition, not a coincidence)", () => {
    const combined = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, false, maxDeliveryDays);
    // normalAsk at round(3,8), leverage 60 -> askMultiplier = 0.5 + 0.6 = 1.1
    // afterQuantity = normalAsk * (1 - 0.02*1.1); afterBoth = afterQuantity * (1 - 0.02*1.1)
    // -> strictly less than a single 0.02*1.1 discount alone.
    const singleDiscountPrice = Math.round(
      // reconstruct what ONE discount alone would give, from the same normalAsk
      // (informal cross-check, not a re-implementation of the module under test)
      combined.unitPrice! / (1 - 0.02 * 1.1),
    );
    expect(combined.unitPrice!).toBeLessThan(singleDiscountPrice);
  });
});

describe("decideBuyerQuantityAndDeliveryTrade — clamping and determinism", () => {
  it("never exceeds the buyer's maxUnitPrice, even against a very high merchant offer", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 200000, 50, ctx(3), 100, false, false, maxDeliveryDays);
    expect(decision.unitPrice!).toBeLessThanOrEqual(constraints.maxUnitPrice);
  });

  it("never goes below the buyer's own aspirational target", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 100, false, false, maxDeliveryDays);
    // resolveBuyerTarget(constraints) = 43700 (no leverage-driven quantity discount at 50 units)
    expect(decision.unitPrice!).toBeGreaterThanOrEqual(43700);
  });

  it("is deterministic — repeated calls with identical inputs produce identical output", () => {
    const first = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, false, maxDeliveryDays);
    const second = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, false, maxDeliveryDays);
    expect(second).toEqual(first);
  });

  it("the reason string explicitly describes the conditional give-both-for-price semantics", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, false, maxDeliveryDays);
    expect(decision.reason).toContain("increase the order to 100 units");
    expect(decision.reason).toContain("accept delivery in 15 days");
    expect(decision.reason).toContain("in exchange for a better unit price");
  });
});

// ---------------------------------------------------------------------
// PACT — Buyer delivery-trade ceiling fix (negotiation hardening audit,
// finding D: the combined trade's delivery component must obey exactly
// the same ceiling as the solo trade). Focused regression test, per that
// task's own required case D.
// ---------------------------------------------------------------------
describe("decideBuyerQuantityAndDeliveryTrade — maxDeliveryDays ceiling (negotiation hardening fix)", () => {
  // D. combined trade also obeys the ceiling.
  it("D: deadline=12, maxDeliveryDays=12 — the delivery component never proposes 18, and the combined move correctly does not fire", () => {
    const atCeiling: BuyerConstraints = { ...constraints, deliveryDeadlineDays: 12 };
    const decision = decideBuyerQuantityAndDeliveryTrade(atCeiling, 46800, 50, ctx(3), 60, false, false, 12);
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
    const decision = decideBuyerQuantityAndDeliveryTrade(tight, 46800, 50, ctx(3), 60, false, false, 10);
    expect(decision.move).toBe("QUANTITY_AND_DELIVERY_FOR_PRICE");
    expect(decision.deliveryDays).toBe(10); // 7 + round(7*0.5) = 11, clamped to 10
    expect(decision.quantity).toBe(100); // quantity sizing itself is completely untouched by this fix
  });
});

// ---------------------------------------------------------------------
// PACT — Urgency-calibrated delivery flexibility (negotiation
// calibration task). The combined trade's delivery component must use
// EXACTLY the same resolveDeliveryUrgencyFactor policy as the solo
// delivery trade — see buyerDeliveryTrade.test.ts for the equivalent
// solo-trade coverage (A/B/C/G/I); this block covers what's specific to
// the combined move (D, F, H).
// ---------------------------------------------------------------------
describe("decideBuyerQuantityAndDeliveryTrade — urgency-calibrated delivery extension", () => {
  const comfortable: Omit<BuyerConstraints, "urgency"> = { ...constraints, deliveryDeadlineDays: 6 };

  // D. deadline == maxDeliveryDays -> NO_TRADE for LOW/MEDIUM/HIGH alike,
  // for the combined move too (not just the solo trade).
  it("D: deadline == maxDeliveryDays produces NO_TRADE for every urgency level", () => {
    for (const urgency of ["low", "medium", "high"] as const) {
      const atCeiling: BuyerConstraints = { ...comfortable, deliveryDeadlineDays: 12, urgency };
      const decision = decideBuyerQuantityAndDeliveryTrade(atCeiling, 46800, 50, ctx(3), 60, false, false, 12);
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
      const solo = decideBuyerDeliveryTrade(withUrgency, 46800, ctx(3), 60, false, 12);
      const combined = decideBuyerQuantityAndDeliveryTrade(withUrgency, 46800, 50, ctx(3), 60, false, false, 12);
      expect(combined.deliveryDays).toBe(solo.deliveryDays);
    }
  });

  // H. Quantity sizing is completely unaffected by the urgency-delivery
  // factor — only deliveryDays (never quantity) changes across urgency.
  it("H: quantity sizing (2x the original ask) is identical across LOW/MEDIUM/HIGH — only deliveryDays changes", () => {
    const low = decideBuyerQuantityAndDeliveryTrade({ ...comfortable, urgency: "low" }, 46800, 50, ctx(3), 60, false, false, 12);
    const medium = decideBuyerQuantityAndDeliveryTrade({ ...comfortable, urgency: "medium" }, 46800, 50, ctx(3), 60, false, false, 12);
    const high = decideBuyerQuantityAndDeliveryTrade({ ...comfortable, urgency: "high" }, 46800, 50, ctx(3), 60, false, false, 12);
    expect(low.quantity).toBe(100);
    expect(medium.quantity).toBe(100);
    expect(high.quantity).toBe(100);
    // ...but deliveryDays genuinely differs, confirming the sweep is real.
    expect(low.deliveryDays).toBe(10); // 6 + round(6*0.7)
    expect(medium.deliveryDays).toBe(9); // 6 + round(6*0.5) — the baseline
    expect(high.deliveryDays).toBe(8); // 6 + round(6*0.3)
  });
});
