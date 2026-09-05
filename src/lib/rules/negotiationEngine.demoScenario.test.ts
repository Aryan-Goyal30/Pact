import { describe, expect, it } from "vitest";
import type { CatalogItemSnapshot } from "./catalogRules";
import { evaluateNegotiationRequest } from "./negotiationEngine";

// PACT's headline demo scenario / project brief:
//
//   Buyer wants 200 laptops, max ₹45,000/unit, delivery within 10 days.
//   Merchant has 100 laptops, listed ₹48,000, private floor ₹44,000,
//   standard delivery 5 days, max delivery 12 days, negotiation enabled.
//
// This mirrors the actual seeded LAPTOP-14-I5 catalog item (see
// prisma/seed.ts). The point of this test is to prove the engine does
// NOT simply reject the deal because 200 units aren't available — it
// should find the largest legitimate sale it can still make.
const laptop: CatalogItemSnapshot = {
  sku: "LAPTOP-14-I5",
  listedPrice: 48000,
  minPrice: 44000,
  availableQty: 100,
  standardDeliveryDays: 5,
  maxDeliveryDays: 12,
  negotiationEnabled: true,
};

describe("demo scenario: 200 laptops requested, 100 available", () => {
  it("offers a commercially viable partial fulfillment instead of rejecting the whole request", () => {
    const result = evaluateNegotiationRequest(laptop, {
      sku: "LAPTOP-14-I5",
      quantity: 200,
      maxUnitPrice: 45000,
      deliveryDeadlineDays: 10,
    });

    // It's a real, structured offer — not a flat rejection.
    expect(result.outcome).toBe("PARTIAL_FULFILLMENT");

    // Never more than the merchant actually has.
    expect(result.offeredQuantity).not.toBeNull();
    expect(result.offeredQuantity).toBeLessThanOrEqual(laptop.availableQty);
    expect(result.offeredQuantity).toBe(100);

    // Never below the merchant's private floor.
    expect(result.unitPrice).not.toBeNull();
    expect(result.unitPrice!).toBeGreaterThanOrEqual(laptop.minPrice);

    // Never a delivery promise the merchant can't keep, and it must fit
    // within the buyer's stated 10-day deadline.
    expect(result.deliveryDays).not.toBeNull();
    expect(result.deliveryDays!).toBeLessThanOrEqual(laptop.maxDeliveryDays);
    expect(result.deliveryDays!).toBeLessThanOrEqual(10);

    // The offer explains itself.
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.requestedQuantity).toBe(200);
  });
});
