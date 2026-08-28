import { describe, expect, it } from "vitest";
import { decideBuyerDeliveryTrade } from "./buyerDeliveryTrade";
import type { BuyerConstraints } from "./buyerRules";

const constraints: BuyerConstraints = {
  sku: "LAPTOP-14-I5",
  quantity: 40,
  maxUnitPrice: 45500,
  deliveryDeadlineDays: 8,
  urgency: "high",
  deliveryFlexible: true,
};
const concessionContext = { round: 2, maxRounds: 10 };

describe("decideBuyerDeliveryTrade", () => {
  // Buyer can identify a useful delivery-for-price opportunity.
  it("proposes DELIVERY_FOR_PRICE with a real price gap and rounds to spare", () => {
    const decision = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, 26, false);
    expect(decision.move).toBe("DELIVERY_FOR_PRICE");
    // Verified empirically against the real orchestrator's own golden
    // trajectory (see orchestrator.test.ts) — not hand-derived.
    expect(decision.deliveryDays).toBe(12); // 8 + round(8 * 0.5)
    expect(decision.unitPrice).toBe(44625);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  describe("does not trade when conditions are not useful", () => {
    it("the buyer has not indicated any delivery flexibility", () => {
      const inflexible: BuyerConstraints = { ...constraints, deliveryFlexible: false };
      const decision = decideBuyerDeliveryTrade(inflexible, 46209, concessionContext, 26, false);
      expect(decision.move).toBe("NO_TRADE");
      expect(decision.reason).toContain("flexibility");
    });

    it("too few rounds remain (final-two-round safety net)", () => {
      const decision = decideBuyerDeliveryTrade(constraints, 46209, { round: 9, maxRounds: 10 }, 26, false);
      expect(decision.move).toBe("NO_TRADE");
    });

    it("the chip has already been used earlier in this negotiation", () => {
      const decision = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, 26, true);
      expect(decision.move).toBe("NO_TRADE");
      expect(decision.reason).toContain("already used");
    });

    it("no real price gap remains (merchant's offer is already at or below target)", () => {
      const decision = decideBuyerDeliveryTrade(constraints, 43000, concessionContext, 26, false);
      expect(decision.move).toBe("NO_TRADE");
    });

    it("no leverage signal at all — never defaults to eligible", () => {
      const decision = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, false);
      expect(decision.move).toBe("NO_TRADE");
    });
  });

  // Leverage sizes the ask, never gates eligibility — same Milestone 6
  // correction applied to this dimension from day one, not retrofitted.
  describe("leverage modulates the size of the ask, never eligibility", () => {
    it("a high-leverage buyer CAN still trade delivery, and asks for a bigger discount than a moderate-leverage buyer", () => {
      const moderate = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, 26, false);
      const strong = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, 90, false);

      expect(moderate.move).toBe("DELIVERY_FOR_PRICE");
      expect(strong.move).toBe("DELIVERY_FOR_PRICE");
      expect(strong.unitPrice!).toBeLessThan(moderate.unitPrice!);
    });

    it("a low-leverage buyer also trades, with a more modest ask", () => {
      const weak = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, 20, false);
      const strong = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, 90, false);

      expect(weak.move).toBe("DELIVERY_FOR_PRICE");
      expect(weak.unitPrice!).toBeGreaterThan(strong.unitPrice!);
    });
  });

  // Buyer never proposes an unreasonable delivery extension.
  it("proposes a bounded delivery extension — a fixed fraction of the original deadline, not an arbitrary number", () => {
    const decision = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, 26, false);
    expect(decision.deliveryDays).toBe(12); // 8 + 4, per DELIVERY_TRADE_EXTENSION_FRACTION
    expect(decision.deliveryDays!).toBeGreaterThan(constraints.deliveryDeadlineDays);
    expect(decision.deliveryDays!).toBeLessThan(constraints.deliveryDeadlineDays * 3); // bounded
  });

  // Buyer remains within maxUnitPrice.
  it("never proposes a price above the buyer's hard ceiling, even with an extreme merchant offer", () => {
    const decision = decideBuyerDeliveryTrade(constraints, 100000, concessionContext, 26, false);
    if (decision.move === "DELIVERY_FOR_PRICE") {
      expect(decision.unitPrice!).toBeLessThanOrEqual(constraints.maxUnitPrice);
    }
  });

  // Buyer does not repeat the same trade indefinitely.
  it("respects deliveryTradeAlreadyUsed even when every other condition is favorable", () => {
    const decision = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, 26, true);
    expect(decision.move).toBe("NO_TRADE");
  });
});
