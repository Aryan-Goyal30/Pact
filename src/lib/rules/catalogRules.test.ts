import { describe, expect, it } from "vitest";
import {
  checkDeliveryAchievable,
  checkPriceAtOrAboveFloor,
  checkQuantityAvailable,
  evaluateFulfillment,
  type CatalogItemSnapshot,
} from "./catalogRules";

const item: CatalogItemSnapshot = {
  sku: "TEST-SKU",
  listedPrice: 1000,
  minPrice: 800,
  availableQty: 50,
  standardDeliveryDays: 5,
  maxDeliveryDays: 12,
  negotiationEnabled: true,
};

describe("checkQuantityAvailable", () => {
  it("reports full availability when the request is within stock", () => {
    const result = checkQuantityAvailable(item, 10);
    expect(result.isFullyAvailable).toBe(true);
    expect(result.fulfillableQuantity).toBe(10);
  });

  it("caps fulfillable quantity when the request exceeds stock", () => {
    const result = checkQuantityAvailable(item, 100);
    expect(result.isFullyAvailable).toBe(false);
    expect(result.fulfillableQuantity).toBe(50);
  });
});

describe("checkPriceAtOrAboveFloor", () => {
  it("accepts a price at or above the floor", () => {
    expect(checkPriceAtOrAboveFloor(item, 900).isAtOrAboveFloor).toBe(true);
    expect(checkPriceAtOrAboveFloor(item, 800).isAtOrAboveFloor).toBe(true);
  });

  it("rejects a price below the floor", () => {
    expect(checkPriceAtOrAboveFloor(item, 700).isAtOrAboveFloor).toBe(false);
  });
});

describe("checkDeliveryAchievable", () => {
  it("accepts a deadline at or after the standard lead time, offering the standard lead time", () => {
    expect(checkDeliveryAchievable(item, 7).isAchievable).toBe(true);
    expect(checkDeliveryAchievable(item, 7).offeredDeliveryDays).toBe(5);
    expect(checkDeliveryAchievable(item, 5).isAchievable).toBe(true);
    expect(checkDeliveryAchievable(item, 5).offeredDeliveryDays).toBe(5);
  });

  // Scenario-behavior fix: a deadline faster than standard is no longer
  // an unconditional impossibility — the merchant can meet it (a genuine
  // rush capability); the caller (merchantAgent.ts) is what applies a
  // price premium for it (see resolveDeliveryRushPremiumFraction,
  // negotiationStrategy.ts) — this function only reports achievability
  // and what the merchant would actually deliver.
  it("accepts a deadline faster than the standard lead time, offering exactly that faster date", () => {
    const result = checkDeliveryAchievable(item, 2);
    expect(result.isAchievable).toBe(true);
    expect(result.offeredDeliveryDays).toBe(2);
  });

  it("rejects a non-positive deadline regardless of price", () => {
    expect(checkDeliveryAchievable(item, 0).isAchievable).toBe(false);
  });

  it("treats no deadline as achievable and offers the standard lead time", () => {
    const result = checkDeliveryAchievable(item, undefined);
    expect(result.isAchievable).toBe(true);
    expect(result.offeredDeliveryDays).toBe(5);
  });
});

describe("evaluateFulfillment", () => {
  it("returns exact_fulfillment when quantity, price, and delivery all fit", () => {
    const outcome = evaluateFulfillment(item, { quantity: 10 });
    expect(outcome.kind).toBe("exact_fulfillment");
    expect(outcome.offeredQuantity).toBe(10);
    expect(outcome.offeredPricePerUnit).toBe(1000);
    expect(outcome.offeredDeliveryDays).toBe(5);
  });

  it("returns partial_fulfillment when the request exceeds stock", () => {
    const outcome = evaluateFulfillment(item, { quantity: 200 });
    expect(outcome.kind).toBe("partial_fulfillment");
    expect(outcome.offeredQuantity).toBe(50);
    expect(outcome.reasons.join(" ")).toMatch(/available/i);
  });

  it("returns price_adjustment_required when the buyer's ceiling is between the floor and listed price", () => {
    const outcome = evaluateFulfillment(item, {
      quantity: 10,
      maxPricePerUnit: 900,
    });
    expect(outcome.kind).toBe("price_adjustment_required");
    expect(outcome.offeredPricePerUnit).toBe(900);
  });

  it("returns impossible when the buyer's price ceiling is below the floor", () => {
    const outcome = evaluateFulfillment(item, {
      quantity: 10,
      maxPricePerUnit: 700,
    });
    expect(outcome.kind).toBe("impossible");
    expect(outcome.offeredQuantity).toBeNull();
  });

  // Scenario-behavior fix: a deadline faster than standard is no longer
  // impossible on its own — see checkDeliveryAchievable's own tests
  // above. A non-positive deadline remains genuinely impossible.
  it("does not return impossible merely for a deadline faster than standard", () => {
    const outcome = evaluateFulfillment(item, {
      quantity: 10,
      deliveryDeadlineDays: 1,
    });
    expect(outcome.kind).not.toBe("impossible");
    expect(outcome.offeredDeliveryDays).toBe(1);
  });

  it("returns impossible for a non-positive delivery deadline", () => {
    const outcome = evaluateFulfillment(item, {
      quantity: 10,
      deliveryDeadlineDays: 0,
    });
    expect(outcome.kind).toBe("impossible");
  });

  it("returns impossible when there is no stock at all", () => {
    const outOfStock: CatalogItemSnapshot = { ...item, availableQty: 0 };
    const outcome = evaluateFulfillment(outOfStock, { quantity: 1 });
    expect(outcome.kind).toBe("impossible");
  });

  it("returns impossible for a partial/price-adjusted request when negotiation is disabled for the item", () => {
    const noNegotiation: CatalogItemSnapshot = {
      ...item,
      negotiationEnabled: false,
    };
    expect(evaluateFulfillment(noNegotiation, { quantity: 200 }).kind).toBe(
      "impossible",
    );
    expect(
      evaluateFulfillment(noNegotiation, { quantity: 10, maxPricePerUnit: 900 })
        .kind,
    ).toBe("impossible");
    // An exact request still succeeds even when negotiation is disabled.
    expect(evaluateFulfillment(noNegotiation, { quantity: 10 }).kind).toBe(
      "exact_fulfillment",
    );
  });
});
