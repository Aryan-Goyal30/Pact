import { describe, expect, it } from "vitest";
import { evaluateMerchantDeliveryTrade } from "./merchantDeliveryTradeEvaluator";
import type { CatalogItemSnapshot } from "./catalogRules";

const baseItem: CatalogItemSnapshot = {
  sku: "LAPTOP-14-I5",
  listedPrice: 48000,
  minPrice: 44000,
  availableQty: 30,
  standardDeliveryDays: 5,
  maxDeliveryDays: 15,
  negotiationEnabled: true,
};

describe("evaluateMerchantDeliveryTrade", () => {
  // 8. Trade below merchant floor is never accepted.
  it("rejects any proposal priced below the floor, regardless of how much delivery time is offered", () => {
    const result = evaluateMerchantDeliveryTrade(
      baseItem,
      { extraDays: 10, unitPrice: 1 },
      { baselineConcessionPrice: 45000 },
    );
    expect(result.verdict).toBe("REJECT");
    expect(result.unitPrice).toBe(45000); // the clamped baseline, not the proposed (below-floor) price
  });

  it("holds at baseline when no meaningful extension is actually offered", () => {
    const result = evaluateMerchantDeliveryTrade(
      baseItem,
      { extraDays: 0, unitPrice: 44625 },
      { baselineConcessionPrice: 45000 },
    );
    expect(result.verdict).toBe("HOLD");
    expect(result.unitPrice).toBe(45000);
  });

  // Different Merchant states produce different delivery-trade
  // evaluations for the IDENTICAL proposal — the central hypothesis this
  // milestone was asked to verify empirically, not assume. Values
  // verified empirically (see the Milestone 7 design/calibration
  // review), not hand-derived.
  describe("the SAME proposal produces materially different behavior by merchant stock state", () => {
    const proposal = { extraDays: 7, unitPrice: 44625 }; // 12-day delivery, 5-day standard
    const baselineConcessionPrice = 45417; // held fixed across stock levels to isolate the stock-pressure effect alone

    it("constrained (low) stock: a real, larger discount — the extra time is genuinely valuable", () => {
      const constrained: CatalogItemSnapshot = { ...baseItem, availableQty: 15 };
      const result = evaluateMerchantDeliveryTrade(constrained, proposal, { baselineConcessionPrice });
      expect(result.verdict).toBe("COUNTER");
      expect(result.unitPrice).toBeLessThan(baselineConcessionPrice);
      expect(result.reason).toContain("limited");
    });

    it("medium stock: a modest discount", () => {
      const medium: CatalogItemSnapshot = { ...baseItem, availableQty: 100 };
      const result = evaluateMerchantDeliveryTrade(medium, proposal, { baselineConcessionPrice });
      expect(result.verdict).toBe("COUNTER");
      expect(result.unitPrice).toBeLessThan(baselineConcessionPrice);
    });

    it("abundant (high) stock: HOLD — no operational value to reward with a lower price", () => {
      const abundant: CatalogItemSnapshot = { ...baseItem, availableQty: 5000 };
      const result = evaluateMerchantDeliveryTrade(abundant, proposal, { baselineConcessionPrice });
      expect(result.verdict).toBe("HOLD");
      expect(result.unitPrice).toBe(baselineConcessionPrice);
      expect(result.reason).toContain("abundant");
    });

    it("constrained stock grants a materially bigger discount than medium stock for the identical proposal", () => {
      const constrained: CatalogItemSnapshot = { ...baseItem, availableQty: 15 };
      const medium: CatalogItemSnapshot = { ...baseItem, availableQty: 100 };
      const constrainedResult = evaluateMerchantDeliveryTrade(constrained, proposal, { baselineConcessionPrice });
      const mediumResult = evaluateMerchantDeliveryTrade(medium, proposal, { baselineConcessionPrice });
      expect(constrainedResult.unitPrice).toBeLessThan(mediumResult.unitPrice);
    });
  });

  // Merchant can counter/reject an unattractive package — an accept only
  // happens when the discounted price already clears the buyer's own ask.
  it("counters (does not force an accept) when the discount doesn't fully clear the buyer's ask", () => {
    const result = evaluateMerchantDeliveryTrade(
      { ...baseItem, availableQty: 100 },
      { extraDays: 3, unitPrice: 44100 }, // a small extension, an aggressive price ask
      { baselineConcessionPrice: 45417 },
    );
    expect(result.verdict).toBe("COUNTER");
    expect(result.unitPrice).toBeGreaterThan(44100);
  });

  it("accepts outright when the merchant's own discount already clears the buyer's ask", () => {
    const result = evaluateMerchantDeliveryTrade(
      { ...baseItem, availableQty: 15 }, // constrained -> generous discount
      { extraDays: 10, unitPrice: 44100 },
      { baselineConcessionPrice: 44200 },
    );
    expect(result.verdict).toBe("ACCEPT");
    expect(result.unitPrice).toBe(44100);
  });

  it("never produces a price below minPrice, however generous the delivery extension", () => {
    const result = evaluateMerchantDeliveryTrade(
      { ...baseItem, availableQty: 5 },
      { extraDays: 10, unitPrice: 44050 },
      { baselineConcessionPrice: 44050 },
    );
    expect(result.unitPrice).toBeGreaterThanOrEqual(baseItem.minPrice);
  });
});
