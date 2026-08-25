import { describe, expect, it } from "vitest";
import type { ProposedAgreement } from "./negotiationEngine";
import {
  isDeliveryAcceptable,
  isPriceAcceptable,
  isQuantityAcceptable,
  isSkuMatch,
  toNegotiationRequest,
  validateMerchantProposal,
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
