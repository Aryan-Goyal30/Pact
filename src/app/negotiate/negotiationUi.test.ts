import { describe, expect, it } from "vitest";
import {
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
