import { describe, expect, it } from "vitest";
import type { ProposedAgreement } from "./negotiationEngine";
import {
  computeBuyerConcessionPrice,
  isDeliveryAcceptable,
  isPriceAcceptable,
  isQuantityAcceptable,
  isSkuMatch,
  resolveBuyerTarget,
  toNegotiationRequest,
  validateMerchantProposal,
  type BuyerConcessionContext,
  type BuyerConstraints,
} from "./buyerRules";

const constraints: BuyerConstraints = {
  sku: "LAPTOP-14-I5",
  quantity: 200,
  maxUnitPrice: 45000,
  deliveryDeadlineDays: 10,
};

const acceptableProposal: ProposedAgreement = {
  sku: "LAPTOP-14-I5",
  quantity: 100,
  unitPrice: 45000,
  deliveryDays: 5,
};

describe("toNegotiationRequest", () => {
  it("carries the buyer's constraints into a NegotiationRequest", () => {
    expect(toNegotiationRequest(constraints)).toEqual({
      sku: "LAPTOP-14-I5",
      quantity: 200,
      maxUnitPrice: 45000,
      deliveryDeadlineDays: 10,
      buyerContext: undefined,
    });
  });
});

describe("isSkuMatch", () => {
  it("accepts a proposal for the requested SKU", () => {
    expect(isSkuMatch(constraints, acceptableProposal)).toBe(true);
  });

  it("rejects a proposal for a different SKU", () => {
    expect(isSkuMatch(constraints, { ...acceptableProposal, sku: "MONITOR-24-FHD" })).toBe(false);
  });
});

describe("isQuantityAcceptable", () => {
  it("accepts a positive quantity at or below what was requested", () => {
    expect(isQuantityAcceptable(constraints, { ...acceptableProposal, quantity: 100 })).toBe(true);
    expect(isQuantityAcceptable(constraints, { ...acceptableProposal, quantity: 200 })).toBe(true);
  });

  it("rejects a quantity above what was requested, or zero/negative", () => {
    expect(isQuantityAcceptable(constraints, { ...acceptableProposal, quantity: 201 })).toBe(false);
    expect(isQuantityAcceptable(constraints, { ...acceptableProposal, quantity: 0 })).toBe(false);
  });
});

// 1. Buyer constraints reject a price above the buyer's maximum.
describe("isPriceAcceptable", () => {
  it("accepts a price at or below the buyer's maximum", () => {
    expect(isPriceAcceptable(constraints, { ...acceptableProposal, unitPrice: 45000 })).toBe(true);
    expect(isPriceAcceptable(constraints, { ...acceptableProposal, unitPrice: 40000 })).toBe(true);
  });

  it("rejects a price above the buyer's maximum", () => {
    expect(isPriceAcceptable(constraints, { ...acceptableProposal, unitPrice: 46500 })).toBe(false);
  });
});

// 2. Buyer constraints reject delivery after the buyer deadline.
describe("isDeliveryAcceptable", () => {
  it("accepts delivery at or before the buyer's deadline", () => {
    expect(isDeliveryAcceptable(constraints, { ...acceptableProposal, deliveryDays: 10 })).toBe(true);
    expect(isDeliveryAcceptable(constraints, { ...acceptableProposal, deliveryDays: 5 })).toBe(true);
  });

  it("rejects delivery after the buyer's deadline", () => {
    expect(isDeliveryAcceptable(constraints, { ...acceptableProposal, deliveryDays: 11 })).toBe(false);
  });
});

describe("validateMerchantProposal", () => {
  it("is ACCEPTABLE when every check passes", () => {
    const result = validateMerchantProposal(constraints, acceptableProposal);
    expect(result.outcome).toBe("ACCEPTABLE");
    expect(result.reasons).toEqual([]);
  });

  it("is UNACCEPTABLE and reports every failing reason at once", () => {
    const result = validateMerchantProposal(constraints, {
      sku: "OTHER-SKU",
      quantity: 300,
      unitPrice: 50000,
      deliveryDays: 20,
    });
    expect(result.outcome).toBe("UNACCEPTABLE");
    expect(result.reasons).toHaveLength(4);
  });

  // 6. Buyer cannot bypass its own constraints — no code path exists to
  // force ACCEPTABLE for a proposal that violates the buyer's own
  // numbers; the checks are pure functions of the proposal's fields.
  it("cannot be made to accept a proposal that violates the buyer's price ceiling, regardless of other fields", () => {
    const result = validateMerchantProposal(constraints, {
      ...acceptableProposal,
      unitPrice: 46500,
    });
    expect(result.outcome).toBe("UNACCEPTABLE");
    expect(result.reasons.join(" ")).toMatch(/exceeds the buyer's maximum/i);
  });
});

describe("resolveBuyerTarget", () => {
  it("derives a target below maxUnitPrice when none is given explicitly", () => {
    const target = resolveBuyerTarget(constraints);
    expect(target).toBeLessThan(constraints.maxUnitPrice);
    expect(target).toBeGreaterThan(0);
  });

  it("uses an explicit targetUnitPrice when supplied, clamped to maxUnitPrice", () => {
    expect(resolveBuyerTarget({ ...constraints, targetUnitPrice: 43000 })).toBe(43000);
    // A target above the ceiling makes no sense — clamp it down.
    expect(resolveBuyerTarget({ ...constraints, targetUnitPrice: 999999 })).toBe(
      constraints.maxUnitPrice,
    );
  });
});

describe("computeBuyerConcessionPrice", () => {
  const roundContext = (round: number, maxRounds = 4): BuyerConcessionContext => ({
    round,
    maxRounds,
  });

  // 1. Buyer can make progressive concessions.
  it("moves partway from its target toward the merchant's current offer on a middle round", () => {
    const target = resolveBuyerTarget(constraints);
    const price = computeBuyerConcessionPrice(constraints, 45375, roundContext(2));
    expect(price).toBeGreaterThan(target);
    expect(price).toBeLessThan(45375);
    expect(price).toBeLessThanOrEqual(constraints.maxUnitPrice);
  });

  it("moves further (or holds) as the merchant's offer improves, rather than repeating the same number", () => {
    const first = computeBuyerConcessionPrice(constraints, 46500, roundContext(2));
    const second = computeBuyerConcessionPrice(constraints, 45375, roundContext(2));
    expect(second).not.toBe(first);
  });

  // 2. Buyer never exceeds its maximum.
  it("never exceeds maxUnitPrice, even on the final round or against a very high merchant offer", () => {
    expect(computeBuyerConcessionPrice(constraints, 100000, roundContext(2))).toBeLessThanOrEqual(
      constraints.maxUnitPrice,
    );
    expect(computeBuyerConcessionPrice(constraints, 100000, roundContext(4))).toBeLessThanOrEqual(
      constraints.maxUnitPrice,
    );
  });

  it("goes to its true ceiling on the final rounds rather than losing a still-worthwhile deal", () => {
    expect(computeBuyerConcessionPrice(constraints, 45375, roundContext(3))).toBe(
      constraints.maxUnitPrice,
    );
    expect(computeBuyerConcessionPrice(constraints, 45375, roundContext(4))).toBe(
      constraints.maxUnitPrice,
    );
  });

  it("never goes below its own target", () => {
    const target = resolveBuyerTarget(constraints);
    const price = computeBuyerConcessionPrice(constraints, target - 5000, roundContext(2));
    expect(price).toBeGreaterThanOrEqual(target);
  });

  it("is general across different price ranges, not tuned to the laptop scenario", () => {
    const monitorConstraints: BuyerConstraints = {
      sku: "MONITOR-24-FHD",
      quantity: 50,
      maxUnitPrice: 8800,
      deliveryDeadlineDays: 8,
    };
    const target = resolveBuyerTarget(monitorConstraints);
    const price = computeBuyerConcessionPrice(monitorConstraints, 9150, roundContext(2));
    expect(price).toBeGreaterThan(target);
    expect(price).toBeLessThanOrEqual(monitorConstraints.maxUnitPrice);
  });

  // Negotiation Engine V2 (D1/D2): leverageSpeedFactor — symmetric
  // treatment to the merchant side's own leverageSpeedFactor
  // (negotiationEngine.test.ts). "Own" leverage here is the BUYER's.
  describe("leverageSpeedFactor (D1/D2)", () => {
    it("omitting it reproduces the exact formula from before this option existed", () => {
      const withoutLeverage = computeBuyerConcessionPrice(constraints, 45375, roundContext(2));
      const withNeutralLeverage = computeBuyerConcessionPrice(constraints, 45375, {
        ...roundContext(2),
        leverageSpeedFactor: 1,
      });
      expect(withoutLeverage).toBe(withNeutralLeverage);
    });

    it("a factor above 1 (weaker buyer leverage) concedes further (a higher price); below 1 (stronger buyer leverage) concedes less", () => {
      const baseline = computeBuyerConcessionPrice(constraints, 45375, roundContext(2));
      const weakerBuyer = computeBuyerConcessionPrice(constraints, 45375, {
        ...roundContext(2),
        leverageSpeedFactor: 1.5,
      });
      const strongerBuyer = computeBuyerConcessionPrice(constraints, 45375, {
        ...roundContext(2),
        leverageSpeedFactor: 0.5,
      });
      expect(weakerBuyer).toBeGreaterThan(baseline); // concedes further -> moves closer to the merchant, a higher price
      expect(strongerBuyer).toBeLessThan(baseline); // concedes less -> stays closer to target, a lower price
    });

    it("never exceeds maxUnitPrice, even with the most extreme leverage factor", () => {
      const price = computeBuyerConcessionPrice(constraints, 100000, {
        ...roundContext(2),
        leverageSpeedFactor: 1.5,
      });
      expect(price).toBeLessThanOrEqual(constraints.maxUnitPrice);
    });

    it("does not apply in the final-2-rounds settle-at-ceiling branch — the guaranteed-convergence safety net is unaffected", () => {
      const withheld = computeBuyerConcessionPrice(constraints, 45375, {
        ...roundContext(4),
        leverageSpeedFactor: 1.5,
      });
      expect(withheld).toBe(constraints.maxUnitPrice);
    });
  });

  // Negotiation Engine V2 (D3): round progression, symmetric to the
  // merchant side's own equivalent test.
  describe("round progression (D3)", () => {
    it("the SAME opposing offer concedes further (moves closer to it) in a later-progress round than an earlier one, all else equal", () => {
      const early = computeBuyerConcessionPrice(constraints, 45375, { round: 2, maxRounds: 10 });
      const late = computeBuyerConcessionPrice(constraints, 45375, { round: 8, maxRounds: 10 });
      expect(late).toBeGreaterThan(early); // later progress -> more pressure to converge -> moves further toward the merchant
    });
  });
});
