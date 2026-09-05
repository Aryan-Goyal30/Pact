// Tests for the deterministic buyer-vs-merchant leverage score.

import { describe, expect, it } from "vitest";
import { computeLeverage, type LeverageInput } from "./leverage";

const laptop: LeverageInput["item"] = {
  availableQty: 100,
  listedPrice: 48000,
  minPrice: 44000,
  standardDeliveryDays: 5,
  maxDeliveryDays: 12,
};

const baseline: LeverageInput = {
  item: laptop,
  buyerConstraints: { quantity: 10, deliveryDeadlineDays: 5 },
  currentMerchantUnitPrice: null,
};

describe("computeLeverage — bounds", () => {
  it("buyerLeverage + merchantLeverage always equals 100", () => {
    const cases: LeverageInput[] = [
      baseline,
      { ...baseline, buyerConstraints: { ...baseline.buyerConstraints, quantity: 5000 } },
      { ...baseline, item: { ...laptop, availableQty: 5000 } },
      { ...baseline, currentMerchantUnitPrice: 44000 },
      { ...baseline, currentMerchantUnitPrice: 48000 },
      {
        ...baseline,
        buyerConstraints: { quantity: 5000, deliveryDeadlineDays: 12, urgency: "low", deliveryFlexible: true },
        item: { ...laptop, availableQty: 5000 },
        currentMerchantUnitPrice: 44000,
      },
    ];
    for (const input of cases) {
      const { buyerLeverage, merchantLeverage } = computeLeverage(input);
      expect(buyerLeverage + merchantLeverage).toBe(100);
    }
  });

  it("never produces a leverage value outside 0-100, even for extreme stacked inputs", () => {
    const extremeBuyerFavor = computeLeverage({
      item: { ...laptop, availableQty: 100000 },
      buyerConstraints: { quantity: 100000, deliveryDeadlineDays: 12, urgency: "low", deliveryFlexible: true },
      currentMerchantUnitPrice: 44000,
    });
    expect(extremeBuyerFavor.buyerLeverage).toBeGreaterThanOrEqual(0);
    expect(extremeBuyerFavor.buyerLeverage).toBeLessThanOrEqual(100);

    const extremeMerchantFavor = computeLeverage({
      item: { ...laptop, availableQty: 1 },
      buyerConstraints: { quantity: 100000, deliveryDeadlineDays: 5, urgency: "high", deliveryFlexible: false },
      currentMerchantUnitPrice: 48000,
    });
    expect(extremeMerchantFavor.merchantLeverage).toBeGreaterThanOrEqual(0);
    expect(extremeMerchantFavor.merchantLeverage).toBeLessThanOrEqual(100);
  });

  it("a genuinely neutral input (quantity matching stock, no urgency/flexibility signal, no offer yet) sits near the 50/50 midpoint", () => {
    // quantity === availableQty zeroes out the fulfillability component;
    // a small availableQty keeps the (always-nonnegative) bulk-quantity
    // component negligible too, so this fixture isolates "no dominant
    // factor" rather than accidentally cancelling out two large opposing pulls.
    const { buyerLeverage, merchantLeverage } = computeLeverage({
      item: { ...laptop, availableQty: 31 },
      buyerConstraints: { quantity: 31, deliveryDeadlineDays: 5 },
      currentMerchantUnitPrice: null,
    });
    expect(buyerLeverage).toBeGreaterThanOrEqual(40);
    expect(buyerLeverage).toBeLessThanOrEqual(60);
    expect(merchantLeverage).toBeGreaterThanOrEqual(40);
    expect(merchantLeverage).toBeLessThanOrEqual(60);
  });
});

describe("computeLeverage — structural factors", () => {
  // A/C. Large quantity from a well-stocked merchant increases buyer leverage.
  it("a large order against ample stock increases buyer leverage", () => {
    const abundant = computeLeverage({
      item: { ...laptop, availableQty: 1000 },
      buyerConstraints: { quantity: 400, deliveryDeadlineDays: 5 },
      currentMerchantUnitPrice: null,
    });
    expect(abundant.buyerLeverage).toBeGreaterThan(50);
  });

  // B/J. Requesting more than is available (even at large quantity) hands the merchant leverage.
  it("requesting more than available stock increases merchant leverage, even for a large order", () => {
    const scarce = computeLeverage({
      item: { ...laptop, availableQty: 100 },
      buyerConstraints: { quantity: 500, deliveryDeadlineDays: 5 },
      currentMerchantUnitPrice: null,
    });
    expect(scarce.merchantLeverage).toBeGreaterThan(50);
  });

  // D. Urgent delivery reduces buyer leverage.
  it("high urgency reduces buyer leverage relative to low urgency, all else equal", () => {
    const urgent = computeLeverage({ ...baseline, buyerConstraints: { ...baseline.buyerConstraints, urgency: "high" } });
    const patient = computeLeverage({ ...baseline, buyerConstraints: { ...baseline.buyerConstraints, urgency: "low" } });
    expect(urgent.buyerLeverage).toBeLessThan(patient.buyerLeverage);
  });

  // E. Delivery flexibility (with real slack) increases buyer leverage.
  it("delivery flexibility with real slack increases buyer leverage", () => {
    const flexible = computeLeverage({
      ...baseline,
      buyerConstraints: { ...baseline.buyerConstraints, deliveryDeadlineDays: 12, deliveryFlexible: true },
    });
    const inflexible = computeLeverage({
      ...baseline,
      buyerConstraints: { ...baseline.buyerConstraints, deliveryDeadlineDays: 12, deliveryFlexible: false },
    });
    expect(flexible.buyerLeverage).toBeGreaterThan(inflexible.buyerLeverage);
  });

  it("delivery flexibility with no real slack (deadline already at the merchant's standard) has no effect", () => {
    const flexibleNoSlack = computeLeverage({
      ...baseline,
      buyerConstraints: { ...baseline.buyerConstraints, deliveryDeadlineDays: 5, deliveryFlexible: true },
    });
    const inflexibleNoSlack = computeLeverage({
      ...baseline,
      buyerConstraints: { ...baseline.buyerConstraints, deliveryDeadlineDays: 5, deliveryFlexible: false },
    });
    expect(flexibleNoSlack.buyerLeverage).toBe(inflexibleNoSlack.buyerLeverage);
  });
});

describe("computeLeverage — dynamic price-position factor", () => {
  // The graph should visibly change round to round as the price moves,
  // even with every structural input held fixed.
  it("leverage shifts toward the buyer as the merchant's current offer approaches the floor", () => {
    const nearListed = computeLeverage({ ...baseline, currentMerchantUnitPrice: 47800 });
    const nearFloor = computeLeverage({ ...baseline, currentMerchantUnitPrice: 44200 });
    expect(nearFloor.buyerLeverage).toBeGreaterThan(nearListed.buyerLeverage);
  });

  it("no merchant offer yet contributes no price-position skew", () => {
    const noOffer = computeLeverage(baseline);
    const atListed = computeLeverage({ ...baseline, currentMerchantUnitPrice: laptop.listedPrice });
    // At exactly listedPrice, price-position component is 0 (fraction=0 -> (0-0.5)*0.6 = -0.3, NOT neutral)
    // so instead assert noOffer sits between atListed and the near-floor case, proving null is treated
    // as neutral rather than pulled toward either extreme.
    const nearFloor = computeLeverage({ ...baseline, currentMerchantUnitPrice: 44200 });
    expect(noOffer.buyerLeverage).toBeGreaterThan(atListed.buyerLeverage);
    expect(noOffer.buyerLeverage).toBeLessThan(nearFloor.buyerLeverage);
  });
});

describe("computeLeverage — reasons", () => {
  it("explains dominant factors with human-readable reasons, capped at 3", () => {
    const { reasons } = computeLeverage({
      item: { ...laptop, availableQty: 1000 },
      buyerConstraints: { quantity: 500, deliveryDeadlineDays: 12, urgency: "low", deliveryFlexible: true },
      currentMerchantUnitPrice: 44200,
    });
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.length).toBeLessThanOrEqual(3);
    expect(reasons.every((r) => r.length > 0)).toBe(true);
  });

  it("produces no reasons when every factor is near-neutral", () => {
    const { reasons } = computeLeverage({
      item: { ...laptop, availableQty: 31 },
      buyerConstraints: { quantity: 31, deliveryDeadlineDays: 5 },
      currentMerchantUnitPrice: null,
    });
    expect(reasons).toEqual([]);
  });

  it("explains merchant-favoring scarcity", () => {
    const { reasons } = computeLeverage({
      item: { ...laptop, availableQty: 50 },
      buyerConstraints: { quantity: 500, deliveryDeadlineDays: 5 },
      currentMerchantUnitPrice: null,
    });
    expect(reasons.some((r) => r.toLowerCase().includes("exceeds available stock"))).toBe(true);
  });
});
