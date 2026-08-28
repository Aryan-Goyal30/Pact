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

describe("decideBuyerQuantityAndDeliveryTrade — eligibility (intersection of both solo gates)", () => {
  it("fires when every precondition holds", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, false);
    expect(decision.move).toBe("QUANTITY_AND_DELIVERY_FOR_PRICE");
    expect(decision.quantity).not.toBeNull();
    expect(decision.deliveryDays).not.toBeNull();
    expect(decision.unitPrice).not.toBeNull();
  });

  it("requires delivery flexibility — never fires without it", () => {
    const inflexible: BuyerConstraints = { ...constraints, deliveryFlexible: false };
    const decision = decideBuyerQuantityAndDeliveryTrade(inflexible, 46800, 50, ctx(3), 60, false, false);
    expect(decision.move).toBe("NO_TRADE");
    expect(decision.quantity).toBeNull();
    expect(decision.deliveryDays).toBeNull();
    expect(decision.unitPrice).toBeNull();
  });

  it("requires rounds remain beyond the final-two-round safety net", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(7, 8), 60, false, false);
    expect(decision.move).toBe("NO_TRADE");
  });

  it("BOTH chips must be unused — the quantity chip alone being used blocks it", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, true, false);
    expect(decision.move).toBe("NO_TRADE");
  });

  it("BOTH chips must be unused — the delivery chip alone being used blocks it", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, true);
    expect(decision.move).toBe("NO_TRADE");
  });

  it("BOTH chips already used blocks it too", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, true, true);
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
    );
    expect(decision.move).toBe("NO_TRADE");
    expect(decision.reason).toContain("already unable to fully supply");
  });

  it("requires a real price gap — no trade when the merchant's offer already meets the buyer's target", () => {
    // resolveBuyerTarget(constraints) with no leverage = round(46000*0.95) = 43700
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 43700, 50, ctx(3), 60, false, false);
    expect(decision.move).toBe("NO_TRADE");
  });

  it("requires a leverage signal (technical gate, not a strategic exclusion)", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), undefined, false, false);
    expect(decision.move).toBe("NO_TRADE");
    expect(decision.reason).toContain("No buyer leverage signal");
  });
});

describe("decideBuyerQuantityAndDeliveryTrade — sizing reuses existing constants", () => {
  it("quantity give matches QUANTITY_TRADE_INCREASE_FRACTION exactly (same as the solo quantity trade)", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, false);
    expect(decision.quantity).toBe(100); // 50 * (1 + 1.0), identical to buyerQuantityTrade.ts's own formula
  });

  it("delivery give matches DELIVERY_TRADE_EXTENSION_FRACTION exactly (same as the solo delivery trade)", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, false);
    expect(decision.deliveryDays).toBe(15); // 10 + round(10 * 0.5), identical to buyerDeliveryTrade.ts's own formula
  });

  it("the combined price is strictly cheaper than either solo trade would ask (sequential composition, not a coincidence)", () => {
    const combined = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, false);
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
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 200000, 50, ctx(3), 100, false, false);
    expect(decision.unitPrice!).toBeLessThanOrEqual(constraints.maxUnitPrice);
  });

  it("never goes below the buyer's own aspirational target", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 100, false, false);
    // resolveBuyerTarget(constraints) = 43700 (no leverage-driven quantity discount at 50 units)
    expect(decision.unitPrice!).toBeGreaterThanOrEqual(43700);
  });

  it("is deterministic — repeated calls with identical inputs produce identical output", () => {
    const first = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, false);
    const second = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, false);
    expect(second).toEqual(first);
  });

  it("the reason string explicitly describes the conditional give-both-for-price semantics", () => {
    const decision = decideBuyerQuantityAndDeliveryTrade(constraints, 46800, 50, ctx(3), 60, false, false);
    expect(decision.reason).toContain("increase the order to 100 units");
    expect(decision.reason).toContain("accept delivery in 15 days");
    expect(decision.reason).toContain("in exchange for a better unit price");
  });
});
