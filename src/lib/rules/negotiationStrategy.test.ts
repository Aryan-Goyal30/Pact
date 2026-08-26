// Tests for the deterministic strategic-factor overlays — negotiation
// strategy hardening milestone. Exercises negotiationStrategy.ts's pure
// functions directly, and the two concession formulas
// (computeBuyerConcessionPrice / computeMerchantConcessionPrice) with
// the new optional fields actually supplied, using fixtures deliberately
// chosen to cross the thresholds documented in negotiationStrategy.ts —
// distinct from the neutral-band fixtures the rest of the test suite
// uses, so this file never disturbs any existing pinned scenario.

import { describe, expect, it } from "vitest";
import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import { computeMerchantConcessionPrice, type MerchantConcessionContext } from "@/lib/rules/negotiationEngine";
import { computeBuyerConcessionPrice, resolveBuyerTarget, type BuyerConstraints, type BuyerConcessionContext } from "@/lib/rules/buyerRules";
import {
  hasQuantityLeverage,
  resolveDeliveryTrade,
  resolveMerchantDemandPressure,
  resolveMerchantStockPressure,
  resolveUrgencyConcessionFactor,
  LARGE_ORDER_QUANTITY_THRESHOLD,
} from "./negotiationStrategy";

const laptop: CatalogItemSnapshot = {
  sku: "LAPTOP-14-I5",
  listedPrice: 48000,
  minPrice: 44000,
  availableQty: 100, // neutral stock band
  standardDeliveryDays: 5,
  maxDeliveryDays: 12,
  negotiationEnabled: true,
};

const roundContext = (round: number, previousOfferUnitPrice?: number, maxRounds = 6): MerchantConcessionContext => ({
  round,
  maxRounds,
  previousOfferUnitPrice,
});

const buyerConstraints: BuyerConstraints = {
  sku: "LAPTOP-14-I5",
  quantity: 10,
  maxUnitPrice: 48000,
  deliveryDeadlineDays: 5,
};

const buyerRoundContext = (round: number, maxRounds = 6): BuyerConcessionContext => ({ round, maxRounds });

describe("buyer urgency", () => {
  // 1, 2. High urgency -> less aggressive (moves toward its ceiling
  // faster / ends up at a higher price); low urgency -> more aggressive
  // bargaining (holds nearer its target for longer).
  it("high urgency yields a higher (less aggressive) concession price than low urgency, given identical inputs", () => {
    const low = computeBuyerConcessionPrice(
      { ...buyerConstraints, urgency: "low" },
      46000,
      buyerRoundContext(2),
    );
    const medium = computeBuyerConcessionPrice(
      { ...buyerConstraints, urgency: "medium" },
      46000,
      buyerRoundContext(2),
    );
    const high = computeBuyerConcessionPrice(
      { ...buyerConstraints, urgency: "high" },
      46000,
      buyerRoundContext(2),
    );

    expect(low).toBeLessThan(medium);
    expect(medium).toBeLessThan(high);
  });

  it("omitting urgency reproduces the exact 'medium' formula", () => {
    const withoutUrgency = computeBuyerConcessionPrice(buyerConstraints, 46000, buyerRoundContext(2));
    const withMedium = computeBuyerConcessionPrice(
      { ...buyerConstraints, urgency: "medium" },
      46000,
      buyerRoundContext(2),
    );
    expect(withoutUrgency).toBe(withMedium);
  });

  // 4. Buyer never exceeds its maximum budget, at any urgency level.
  it("never exceeds maxUnitPrice regardless of urgency", () => {
    for (const urgency of ["low", "medium", "high"] as const) {
      const price = computeBuyerConcessionPrice(
        { ...buyerConstraints, urgency },
        1_000_000,
        buyerRoundContext(2),
      );
      expect(price).toBeLessThanOrEqual(buyerConstraints.maxUnitPrice);
    }
  });
});

describe("buyer quantity leverage", () => {
  // 3. Larger order quantities provide more bargaining leverage — a
  // deeper aspirational target for the same maxUnitPrice.
  it("a large order pulls the buyer's target lower than a small order", () => {
    const small = resolveBuyerTarget({ ...buyerConstraints, quantity: 10 });
    const large = resolveBuyerTarget({ ...buyerConstraints, quantity: LARGE_ORDER_QUANTITY_THRESHOLD });
    expect(large).toBeLessThan(small);
  });

  it("hasQuantityLeverage is false below the threshold and true at/above it", () => {
    expect(hasQuantityLeverage(LARGE_ORDER_QUANTITY_THRESHOLD - 1)).toBe(false);
    expect(hasQuantityLeverage(LARGE_ORDER_QUANTITY_THRESHOLD)).toBe(true);
  });
});

describe("merchant stock/demand pressure", () => {
  // 5. High stock pressure -> greater merchant concession (lower price).
  it("high inventory concedes more than the neutral band, given identical inputs", () => {
    const highStock: CatalogItemSnapshot = { ...laptop, availableQty: 1000 };
    const neutral = computeMerchantConcessionPrice(laptop, 45000, roundContext(2, 47000));
    const generous = computeMerchantConcessionPrice(highStock, 45000, roundContext(2, 47000));
    expect(generous).toBeLessThan(neutral);
  });

  // 6. Low inventory -> firmer merchant (smaller concession, higher price).
  it("low inventory concedes less than the neutral band, given identical inputs", () => {
    const lowStock: CatalogItemSnapshot = { ...laptop, availableQty: 15 };
    const neutral = computeMerchantConcessionPrice(laptop, 45000, roundContext(2, 47000));
    const firm = computeMerchantConcessionPrice(lowStock, 45000, roundContext(2, 47000));
    expect(firm).toBeGreaterThan(neutral);
  });

  // 7. High demand pressure (read as scarce stock) keeps the merchant firm.
  it("scarce stock reads as high demand pressure", () => {
    const scarce: CatalogItemSnapshot = { ...laptop, availableQty: 10 };
    expect(resolveMerchantStockPressure(scarce)).toBe("low");
    expect(resolveMerchantDemandPressure(scarce)).toBe("high");
  });

  it("abundant stock reads as low demand pressure", () => {
    const abundant: CatalogItemSnapshot = { ...laptop, availableQty: 1000 };
    expect(resolveMerchantStockPressure(abundant)).toBe("high");
    expect(resolveMerchantDemandPressure(abundant)).toBe("low");
  });

  // 8. Merchant never accepts below its reservation price, under any
  // combination of strategic factors.
  it("never returns a price below minPrice, even with high stock pressure and quantity leverage stacked", () => {
    const highStock: CatalogItemSnapshot = { ...laptop, availableQty: 5000 };
    const price = computeMerchantConcessionPrice(highStock, 1, {
      round: 2,
      maxRounds: 6,
      previousOfferUnitPrice: 44500,
      requestedQuantity: 1000,
    });
    expect(price).toBeGreaterThanOrEqual(laptop.minPrice);
  });
});

describe("quantity influences merchant price negotiation", () => {
  // 10. A large order also earns the buyer an additional merchant-side discount.
  it("a large order concedes more than an identical small order", () => {
    const small = computeMerchantConcessionPrice(laptop, 45000, {
      ...roundContext(2, 47000),
      requestedQuantity: 10,
    });
    const large = computeMerchantConcessionPrice(laptop, 45000, {
      ...roundContext(2, 47000),
      requestedQuantity: LARGE_ORDER_QUANTITY_THRESHOLD,
    });
    expect(large).toBeLessThan(small);
    expect(large).toBeGreaterThanOrEqual(laptop.minPrice);
  });

  it("omitting requestedQuantity reproduces the exact pre-existing formula", () => {
    const withoutQuantity = computeMerchantConcessionPrice(laptop, 45000, roundContext(2, 47000));
    const withSmallQuantity = computeMerchantConcessionPrice(laptop, 45000, {
      ...roundContext(2, 47000),
      requestedQuantity: 10,
    });
    expect(withoutQuantity).toBe(withSmallQuantity);
  });
});

describe("delivery-for-price trade", () => {
  // 9. Delivery can be traded against price.
  it("a flexible buyer with real deadline slack earns a discount and an extended delivery date", () => {
    const trade = resolveDeliveryTrade(laptop, 12, true);
    expect(trade.traded).toBe(true);
    expect(trade.deliveryDays).toBeGreaterThan(laptop.standardDeliveryDays);
    expect(trade.deliveryDays).toBeLessThanOrEqual(laptop.maxDeliveryDays);
    expect(trade.discount).toBeGreaterThan(0);
  });

  it("an inflexible buyer gets no trade even with deadline slack", () => {
    const trade = resolveDeliveryTrade(laptop, 12, false);
    expect(trade.traded).toBe(false);
    expect(trade.deliveryDays).toBe(laptop.standardDeliveryDays);
    expect(trade.discount).toBe(0);
  });

  it("a flexible buyer with no real slack (deadline at or before standard) gets no trade", () => {
    const trade = resolveDeliveryTrade(laptop, laptop.standardDeliveryDays, true);
    expect(trade.traded).toBe(false);
    expect(trade.discount).toBe(0);
  });

  it("feeding the trade discount into computeMerchantConcessionPrice lowers the price and never breaks the floor", () => {
    const trade = resolveDeliveryTrade(laptop, 12, true);
    const withoutTrade = computeMerchantConcessionPrice(laptop, 45000, roundContext(2, 47000));
    const withTrade = computeMerchantConcessionPrice(laptop, 45000, {
      ...roundContext(2, 47000),
      deliveryTradeDiscount: trade.discount,
    });
    expect(withTrade).toBeLessThan(withoutTrade);
    expect(withTrade).toBeGreaterThanOrEqual(laptop.minPrice);
  });
});

describe("resolveUrgencyConcessionFactor", () => {
  it("defaults to the neutral 1.0 factor", () => {
    expect(resolveUrgencyConcessionFactor()).toBe(1.0);
    expect(resolveUrgencyConcessionFactor("medium")).toBe(1.0);
  });
});
