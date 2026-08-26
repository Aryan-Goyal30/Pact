import { describe, expect, it } from "vitest";
import type { NegotiationMessageType } from "@/lib/negotiation/protocol";
import type { PublicManifestProduct } from "@/types/manifest";
import {
  buyerThinkingLabel,
  computeMaxOrderValue,
  formatInr,
  getScenarioPresets,
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
  urgency: "medium",
  deliveryFlexible: false,
};

describe("parseBuyerRequestForm", () => {
  it("parses a valid form into numeric fields", () => {
    const result = parseBuyerRequestForm(validForm);
    expect(result).toEqual({
      sku: "LAPTOP-14-I5",
      quantity: 200,
      maxUnitPrice: 45000,
      deliveryDeadlineDays: 10,
      urgency: "medium",
      deliveryFlexible: false,
    });
  });

  it("carries urgency and deliveryFlexible through unchanged", () => {
    const result = parseBuyerRequestForm({ ...validForm, urgency: "high", deliveryFlexible: true });
    expect(result).toMatchObject({ urgency: "high", deliveryFlexible: true });
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

describe("getScenarioPresets", () => {
  const products: PublicManifestProduct[] = [
    {
      sku: "LAPTOP-14-I5",
      name: "14-inch Business Laptop (i5, 16GB RAM)",
      description: "Mid-range business laptop.",
      listedPrice: 48000,
      availableQuantity: 100,
      standardDeliveryDays: 5,
      maxDeliveryDays: 12,
      negotiable: true,
    },
    {
      sku: "MONITOR-24-FHD",
      name: "24-inch Full HD Monitor",
      description: "Standard office monitor.",
      listedPrice: 9500,
      availableQuantity: 250,
      standardDeliveryDays: 4,
      maxDeliveryDays: 10,
      negotiable: true,
    },
  ];

  it("returns a distinct, non-empty preset for each major scenario", () => {
    const presets = getScenarioPresets(products);
    expect(presets.length).toBeGreaterThanOrEqual(6);
    const ids = presets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
  });

  it("every preset's form values parse successfully", () => {
    for (const preset of getScenarioPresets(products)) {
      const parsed = parseBuyerRequestForm(preset.values);
      expect(typeof parsed).not.toBe("string");
    }
  });

  it("the walk-away preset's budget is genuinely below what the balanced preset asks", () => {
    const presets = getScenarioPresets(products);
    const walkAway = presets.find((p) => p.id === "walk-away");
    const balanced = presets.find((p) => p.id === "balanced");
    expect(walkAway).toBeDefined();
    expect(balanced).toBeDefined();
    expect(Number(walkAway!.values.maxUnitPrice)).toBeLessThan(Number(balanced!.values.maxUnitPrice));
  });

  it("the flexible-delivery preset actually sets deliveryFlexible and real deadline slack", () => {
    const preset = getScenarioPresets(products).find((p) => p.id === "flexible-delivery");
    expect(preset).toBeDefined();
    expect(preset!.values.deliveryFlexible).toBe(true);
  });

  it("never references a product SKU absent from the given catalog", () => {
    const laptopOnly = products.filter((p) => p.sku === "LAPTOP-14-I5");
    const presets = getScenarioPresets(laptopOnly);
    expect(presets.every((p) => p.sku === "LAPTOP-14-I5")).toBe(true);
    expect(presets.some((p) => p.sku === "MONITOR-24-FHD")).toBe(false);
  });

  it("returns nothing when the catalog is empty", () => {
    expect(getScenarioPresets([])).toEqual([]);
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
