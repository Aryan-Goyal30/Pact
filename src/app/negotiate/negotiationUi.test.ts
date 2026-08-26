import { describe, expect, it } from "vitest";
import type { NegotiationMessageType } from "@/lib/negotiation/protocol";
import {
  buyerThinkingLabel,
  computeMaxOrderValue,
  formatInr,
  merchantThinkingLabel,
  negotiationFailureExplanation,
  negotiationMessageTypeBadgeClass,
  negotiationMessageTypeLabel,
  negotiationStatusBadgeClass,
  negotiationStatusLabel,
  parseBuyerRequestForm,
  type BuyerRequestFormValues,
} from "./negotiationUi";

const validForm: BuyerRequestFormValues = {
  sku: "LAPTOP-14-I5",
  quantity: "200",
  maxUnitPrice: "45000",
  deliveryDeadlineDays: "10",
};

describe("parseBuyerRequestForm", () => {
  it("parses a valid form into numeric fields", () => {
    const result = parseBuyerRequestForm(validForm);
    expect(result).toEqual({
      sku: "LAPTOP-14-I5",
      quantity: 200,
      maxUnitPrice: 45000,
      deliveryDeadlineDays: 10,
    });
  });

  it("rejects an empty SKU", () => {
    expect(parseBuyerRequestForm({ ...validForm, sku: "" })).toBe("Choose a product.");
  });

  it("rejects a non-positive quantity", () => {
    expect(parseBuyerRequestForm({ ...validForm, quantity: "0" })).toMatch(/quantity/i);
    expect(parseBuyerRequestForm({ ...validForm, quantity: "-5" })).toMatch(/quantity/i);
    expect(parseBuyerRequestForm({ ...validForm, quantity: "abc" })).toMatch(/quantity/i);
  });

  it("rejects a non-positive maximum unit price", () => {
    expect(parseBuyerRequestForm({ ...validForm, maxUnitPrice: "0" })).toMatch(/price/i);
  });

  it("rejects a non-positive delivery deadline", () => {
    expect(parseBuyerRequestForm({ ...validForm, deliveryDeadlineDays: "-1" })).toMatch(
      /deadline/i,
    );
  });
});

describe("negotiationStatusLabel / negotiationStatusBadgeClass", () => {
  it("has a label and a badge class for every negotiation status", () => {
    const statuses = ["OPEN", "COUNTERED", "AGREED", "REJECTED", "EXPIRED"] as const;
    for (const status of statuses) {
      expect(negotiationStatusLabel(status).length).toBeGreaterThan(0);
      expect(negotiationStatusBadgeClass(status).length).toBeGreaterThan(0);
    }
  });

  it("labels terminal states distinctly", () => {
    expect(negotiationStatusLabel("AGREED")).toBe("Agreed");
    expect(negotiationStatusLabel("REJECTED")).toBe("Rejected");
    expect(negotiationStatusLabel("EXPIRED")).toBe("Expired");
  });
});

describe("buyerThinkingLabel", () => {
  it("distinguishes the opening turn from later turns", () => {
    expect(buyerThinkingLabel(1)).toMatch(/evaluating/i);
    expect(buyerThinkingLabel(2)).toMatch(/considering/i);
    expect(buyerThinkingLabel(1)).not.toBe(buyerThinkingLabel(2));
  });
});

describe("merchantThinkingLabel", () => {
  it("has a distinct, non-empty label for every message type", () => {
    const types: NegotiationMessageType[] = ["request", "offer", "counter_offer", "accept", "reject"];
    for (const type of types) {
      expect(merchantThinkingLabel(type).length).toBeGreaterThan(0);
    }
    expect(merchantThinkingLabel("accept")).toMatch(/accept/i);
    expect(merchantThinkingLabel("reject")).toMatch(/reject/i);
    expect(merchantThinkingLabel("counter_offer")).toMatch(/counter/i);
  });
});

describe("negotiationMessageTypeLabel / negotiationMessageTypeBadgeClass", () => {
  it("has a label and badge class for every message type", () => {
    const types: NegotiationMessageType[] = ["request", "offer", "counter_offer", "accept", "reject"];
    for (const type of types) {
      expect(negotiationMessageTypeLabel(type).length).toBeGreaterThan(0);
      expect(negotiationMessageTypeBadgeClass(type).length).toBeGreaterThan(0);
    }
  });

  it("visually distinguishes accept, reject, and counter-offer from one another", () => {
    const accept = negotiationMessageTypeBadgeClass("accept");
    const reject = negotiationMessageTypeBadgeClass("reject");
    const counter = negotiationMessageTypeBadgeClass("counter_offer");
    expect(new Set([accept, reject, counter]).size).toBe(3);
  });
});

describe("formatInr", () => {
  it("formats a whole-rupee amount with no decimal places", () => {
    expect(formatInr(45000)).toContain("45,000");
  });
});

describe("computeMaxOrderValue", () => {
  it("multiplies quantity by the maximum unit price, never confusing the two", () => {
    expect(computeMaxOrderValue(200, 45000)).toBe(9000000);
    expect(computeMaxOrderValue(1, 45000)).toBe(45000);
  });
});

describe("negotiationFailureExplanation", () => {
  it("gives a distinct explanation for REJECTED vs EXPIRED", () => {
    const rejected = negotiationFailureExplanation("REJECTED");
    const expired = negotiationFailureExplanation("EXPIRED");
    expect(rejected).not.toBe(expired);
    expect(expired).toMatch(/maximum number of.*rounds/i);
  });

  it("never mentions minPrice or any private constraint", () => {
    expect(negotiationFailureExplanation("REJECTED")).not.toMatch(/minprice|floor|reservation/i);
    expect(negotiationFailureExplanation("EXPIRED")).not.toMatch(/minprice|floor|reservation/i);
  });
});
