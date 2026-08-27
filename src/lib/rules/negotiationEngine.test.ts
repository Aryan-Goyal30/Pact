import { describe, expect, it } from "vitest";
import type { CatalogItemSnapshot } from "./catalogRules";
import {
  computeCounterOfferPrice,
  computeMerchantConcessionPrice,
  evaluateNegotiationRequest,
  validateProposedAgreement,
  type MerchantConcessionContext,
} from "./negotiationEngine";

const item: CatalogItemSnapshot = {
  sku: "TEST-SKU",
  listedPrice: 1000,
  minPrice: 800,
  availableQty: 50,
  standardDeliveryDays: 5,
  maxDeliveryDays: 12,
  negotiationEnabled: true,
};

const nonNegotiableItem: CatalogItemSnapshot = {
  ...item,
  sku: "TEST-SKU-FIXED",
  negotiationEnabled: false,
};

describe("evaluateNegotiationRequest", () => {
  // 1. Exact request that can be fulfilled.
  it("returns EXACT_MATCH when quantity, price, and delivery all fit with no concession", () => {
    const result = evaluateNegotiationRequest(item, { sku: item.sku, quantity: 10 });
    expect(result.outcome).toBe("EXACT_MATCH");
    expect(result.offeredQuantity).toBe(10);
    expect(result.unitPrice).toBe(1000);
    expect(result.deliveryDays).toBe(5);
  });

  // 2. Buyer requests more units than available.
  // 3. Partial fulfillment is proposed.
  it("returns PARTIAL_FULFILLMENT capped at available stock when the request exceeds it", () => {
    const result = evaluateNegotiationRequest(item, { sku: item.sku, quantity: 500 });
    expect(result.outcome).toBe("PARTIAL_FULFILLMENT");
    expect(result.offeredQuantity).toBe(50);
    expect(result.requestedQuantity).toBe(500);
    expect(result.reasons.join(" ")).toMatch(/50 unit/i);
  });

  // 4. Buyer price is above listed price.
  it("returns EXACT_MATCH at the listed price when the buyer's ceiling is above it", () => {
    const result = evaluateNegotiationRequest(item, {
      sku: item.sku,
      quantity: 10,
      maxUnitPrice: 5000,
    });
    expect(result.outcome).toBe("EXACT_MATCH");
    expect(result.unitPrice).toBe(1000); // never charges more than listed
  });

  // 5. Buyer price is between listed price and floor.
  it("returns COUNTER_OFFER strictly between floor and listed when the buyer's ceiling sits in that range", () => {
    const result = evaluateNegotiationRequest(item, {
      sku: item.sku,
      quantity: 10,
      maxUnitPrice: 900,
    });
    expect(result.outcome).toBe("COUNTER_OFFER");
    expect(result.unitPrice).toBe(computeCounterOfferPrice(item, 900));
    expect(result.unitPrice).toBeGreaterThanOrEqual(item.minPrice);
    expect(result.unitPrice).toBeLessThan(item.listedPrice);
  });

  // 6. Buyer price is below merchant floor.
  it("counters at the floor price (never below it) when the buyer's ceiling is below the floor", () => {
    const result = evaluateNegotiationRequest(item, {
      sku: item.sku,
      quantity: 10,
      maxUnitPrice: 100,
    });
    expect(result.outcome).toBe("COUNTER_OFFER");
    expect(result.unitPrice).toBe(item.minPrice);
  });

  // 7. Product is non-negotiable.
  it("rejects a discounted or over-quantity request for a non-negotiable item, but still allows the exact listed terms", () => {
    const discounted = evaluateNegotiationRequest(nonNegotiableItem, {
      sku: nonNegotiableItem.sku,
      quantity: 10,
      maxUnitPrice: 900,
    });
    expect(discounted.outcome).toBe("REJECTED");

    const overQuantity = evaluateNegotiationRequest(nonNegotiableItem, {
      sku: nonNegotiableItem.sku,
      quantity: 500,
    });
    expect(overQuantity.outcome).toBe("REJECTED");

    const exact = evaluateNegotiationRequest(nonNegotiableItem, {
      sku: nonNegotiableItem.sku,
      quantity: 10,
    });
    expect(exact.outcome).toBe("EXACT_MATCH");
  });

  // 8. Delivery deadline is achievable.
  it("accepts a delivery deadline at or after the standard lead time", () => {
    const result = evaluateNegotiationRequest(item, {
      sku: item.sku,
      quantity: 10,
      deliveryDeadlineDays: 7,
    });
    expect(result.outcome).toBe("EXACT_MATCH");
    expect(result.deliveryDays).toBe(5);
  });

  // 9. Delivery deadline is impossible.
  it("rejects a delivery deadline faster than the standard lead time", () => {
    const result = evaluateNegotiationRequest(item, {
      sku: item.sku,
      quantity: 10,
      deliveryDeadlineDays: 1,
    });
    expect(result.outcome).toBe("REJECTED");
  });

  // 10. Quantity + price both require adjustment.
  it("adjusts both quantity and price in one PARTIAL_FULFILLMENT offer when both are constrained", () => {
    const result = evaluateNegotiationRequest(item, {
      sku: item.sku,
      quantity: 500,
      maxUnitPrice: 900,
    });
    expect(result.outcome).toBe("PARTIAL_FULFILLMENT");
    expect(result.offeredQuantity).toBe(50);
    expect(result.unitPrice).toBe(computeCounterOfferPrice(item, 900));
    expect(result.reasons.length).toBe(2);
  });

  // 11. Invalid SKU.
  it("rejects when no catalog item is found for the SKU", () => {
    const result = evaluateNegotiationRequest(null, { sku: "DOES-NOT-EXIST", quantity: 10 });
    expect(result.outcome).toBe("REJECTED");
    expect(result.reasons.join(" ")).toMatch(/no catalog item/i);
  });

  // 12. Zero/negative quantity.
  it("rejects zero or negative requested quantity", () => {
    expect(evaluateNegotiationRequest(item, { sku: item.sku, quantity: 0 }).outcome).toBe(
      "REJECTED",
    );
    expect(evaluateNegotiationRequest(item, { sku: item.sku, quantity: -5 }).outcome).toBe(
      "REJECTED",
    );
  });
});

describe("computeCounterOfferPrice", () => {
  it("never returns a value below the floor or above the listed price", () => {
    expect(computeCounterOfferPrice(item, 900)).toBe(950); // midpoint of 1000 and 900
    expect(computeCounterOfferPrice(item, 0)).toBe(item.minPrice); // clamped up to floor
    expect(computeCounterOfferPrice(item, 1000)).toBeLessThanOrEqual(item.listedPrice);
  });
});

describe("computeMerchantConcessionPrice", () => {
  const roundContext = (
    round: number,
    previousOfferUnitPrice?: number,
    maxRounds = 4,
  ): MerchantConcessionContext => ({ round, maxRounds, previousOfferUnitPrice });

  it("matches computeCounterOfferPrice exactly on the opening round (no previous offer)", () => {
    expect(computeMerchantConcessionPrice(item, 900, roundContext(1))).toBe(
      computeCounterOfferPrice(item, 900),
    );
  });

  // 2. The merchant can produce a valid counter-offer above the buyer's
  // current proposed price while remaining <= listedPrice and >= minPrice.
  it("concedes only partway toward the buyer's ceiling on a middle round, staying above it", () => {
    const price = computeMerchantConcessionPrice(item, 900, roundContext(2, 950));
    expect(price).toBeGreaterThan(900); // still above the buyer's ask — not caving
    expect(price).toBeLessThan(950); // but has moved down from its own previous position
    expect(price).toBeLessThanOrEqual(item.listedPrice);
    expect(price).toBeGreaterThanOrEqual(item.minPrice);
  });

  // 1 & 3. On the final usable round(s), the merchant settles exactly at
  // the buyer's ceiling rather than holding out for a price the buyer
  // has already refused every prior round — this is the "no better
  // valid counter to make" convergence point.
  it("settles exactly at the buyer's ceiling once few rounds remain", () => {
    expect(computeMerchantConcessionPrice(item, 900, roundContext(3, 925))).toBe(900);
    expect(computeMerchantConcessionPrice(item, 900, roundContext(4, 900))).toBe(900);
  });

  // 4. The merchant can never produce a price below minPrice.
  it("never returns a price below minPrice, even for a buyer ceiling far below the floor", () => {
    expect(computeMerchantConcessionPrice(item, 1, roundContext(1))).toBeGreaterThanOrEqual(
      item.minPrice,
    );
    expect(computeMerchantConcessionPrice(item, 1, roundContext(4, 810))).toBe(item.minPrice);
  });

  it("is general across different listed/floor/ceiling combinations, not tuned to one SKU", () => {
    const monitor: CatalogItemSnapshot = {
      sku: "MONITOR-24-FHD",
      listedPrice: 9500,
      minPrice: 8200,
      availableQty: 250,
      standardDeliveryDays: 4,
      maxDeliveryDays: 10,
      negotiationEnabled: true,
    };
    const opening = computeMerchantConcessionPrice(monitor, 8800, roundContext(1));
    expect(opening).toBe(computeCounterOfferPrice(monitor, 8800));
    const settled = computeMerchantConcessionPrice(monitor, 8800, roundContext(4, opening));
    expect(settled).toBe(8800);
    expect(settled).toBeGreaterThanOrEqual(monitor.minPrice);
  });

  // Milestone 4: reciprocitySpeedMultiplier — omitting it must reproduce
  // the exact pre-Milestone-4 formula (every existing caller/test).
  describe("reciprocitySpeedMultiplier", () => {
    it("omitting it reproduces the exact formula from before this option existed", () => {
      const withoutMultiplier = computeMerchantConcessionPrice(item, 900, roundContext(2, 950));
      const withNeutralMultiplier = computeMerchantConcessionPrice(item, 900, {
        ...roundContext(2, 950),
        reciprocitySpeedMultiplier: 1,
      });
      expect(withoutMultiplier).toBe(withNeutralMultiplier);
    });

    it("a multiplier above 1 concedes further than the baseline; below 1 concedes less", () => {
      const baseline = computeMerchantConcessionPrice(item, 900, roundContext(2, 950));
      const rewarded = computeMerchantConcessionPrice(item, 900, {
        ...roundContext(2, 950),
        reciprocitySpeedMultiplier: 1.15,
      });
      const withheld = computeMerchantConcessionPrice(item, 900, {
        ...roundContext(2, 950),
        reciprocitySpeedMultiplier: 0.75,
      });

      expect(rewarded).toBeLessThan(baseline); // concedes further (lower price) than baseline
      expect(withheld).toBeGreaterThan(baseline); // concedes less (higher price) than baseline
    });

    it("never breaches [minPrice, listedPrice], even with an aggressive multiplier", () => {
      const price = computeMerchantConcessionPrice(item, 1, {
        ...roundContext(2, 950),
        reciprocitySpeedMultiplier: 1.15,
      });
      expect(price).toBeGreaterThanOrEqual(item.minPrice);
      expect(price).toBeLessThanOrEqual(item.listedPrice);
    });

    it("does not apply in the final-2-rounds settle-at-ceiling branch — the guaranteed-convergence safety net is unaffected", () => {
      const withheld = computeMerchantConcessionPrice(item, 900, {
        ...roundContext(4, 900),
        reciprocitySpeedMultiplier: 0.6,
      });
      expect(withheld).toBe(900); // identical to the unmultiplied final-round settlement
    });
  });
});

describe("validateProposedAgreement", () => {
  // 14. A proposed agreement below minPrice is rejected.
  it("rejects a proposal priced below the floor", () => {
    const result = validateProposedAgreement(item, {
      sku: item.sku,
      quantity: 10,
      unitPrice: 700,
      deliveryDays: 5,
    });
    expect(result.outcome).toBe("REJECTED");
    expect(result.reasons.join(" ")).toMatch(/minimum acceptable price/i);
  });

  // 15. A proposed agreement above available inventory is rejected.
  it("rejects a proposal for more units than are available", () => {
    const result = validateProposedAgreement(item, {
      sku: item.sku,
      quantity: 999,
      unitPrice: 1000,
      deliveryDays: 5,
    });
    expect(result.outcome).toBe("REJECTED");
    expect(result.reasons.join(" ")).toMatch(/available/i);
  });

  // 16. A valid negotiated agreement is accepted.
  it("accepts a valid negotiated proposal within all constraints", () => {
    const result = validateProposedAgreement(item, {
      sku: item.sku,
      quantity: 10,
      unitPrice: 950,
      deliveryDays: 5,
    });
    expect(result.outcome).toBe("ACCEPTED");
    expect(result.reasons).toEqual([]);
  });

  it("rejects an invalid SKU", () => {
    const result = validateProposedAgreement(null, {
      sku: "DOES-NOT-EXIST",
      quantity: 1,
      unitPrice: 1000,
      deliveryDays: 5,
    });
    expect(result.outcome).toBe("REJECTED");
  });

  it("rejects a discounted proposal for a non-negotiable item", () => {
    const result = validateProposedAgreement(nonNegotiableItem, {
      sku: nonNegotiableItem.sku,
      quantity: 10,
      unitPrice: 900,
      deliveryDays: 5,
    });
    expect(result.outcome).toBe("REJECTED");
  });
});
