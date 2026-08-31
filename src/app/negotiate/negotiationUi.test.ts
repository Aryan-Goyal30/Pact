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
    {
      sku: "KEYBOARD-WIRELESS",
      name: "Wireless Keyboard and Mouse Combo",
      description: "Standard wireless keyboard and mouse set.",
      listedPrice: 1400,
      availableQuantity: 500,
      standardDeliveryDays: 3,
      maxDeliveryDays: 7,
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

  it("the walk-away preset's budget is genuinely further below its own product's listed price than the balanced preset's ask is", () => {
    // Catalog/preset recalibration: balanced and walk-away no longer
    // necessarily share a product (balanced moved to MONITOR-24-FHD), so
    // a raw cross-product maxUnitPrice comparison is no longer
    // meaningful (a MONITOR price is never comparable to a LAPTOP price
    // as bare rupee figures). Compare each preset's ask as a FRACTION of
    // its own product's listed price instead — genuinely product-
    // agnostic, and still proves the real intent: walk-away's ask sits
    // proportionally much further below what it would take to succeed.
    const presets = getScenarioPresets(products);
    const walkAway = presets.find((p) => p.id === "walk-away");
    const balanced = presets.find((p) => p.id === "balanced");
    expect(walkAway).toBeDefined();
    expect(balanced).toBeDefined();

    const walkAwayProduct = products.find((p) => p.sku === walkAway!.sku)!;
    const balancedProduct = products.find((p) => p.sku === balanced!.sku)!;
    const walkAwayRatio = Number(walkAway!.values.maxUnitPrice) / walkAwayProduct.listedPrice;
    const balancedRatio = Number(balanced!.values.maxUnitPrice) / balancedProduct.listedPrice;
    expect(walkAwayRatio).toBeLessThan(balancedRatio);
  });

  it("the flexible-delivery preset actually sets deliveryFlexible and real deadline slack", () => {
    const preset = getScenarioPresets(products).find((p) => p.id === "flexible-delivery");
    expect(preset).toBeDefined();
    expect(preset!.values.deliveryFlexible).toBe(true);
    // The deadline must sit strictly below the preset's OWN product's
    // real maxDeliveryDays — looked up dynamically via preset.sku (not
    // hardcoded to one product) so this stays correct regardless of
    // which catalog item the preset targets. Catalog/preset
    // recalibration: flexible-delivery now targets MONITOR-24-FHD
    // (maxDeliveryDays 10, from the manifest fixture above).
    const product = products.find((p) => p.sku === preset!.sku)!;
    expect(Number(preset!.values.deliveryDeadlineDays)).toBeLessThan(product.maxDeliveryDays);
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

  // PACT — Add buyer bulk request demo preset. Focused tests per that
  // task's own required list (1-5).
  describe("buyer-bulk-request (new preset, buyer-side QUANTITY_FOR_PRICE)", () => {
    it("1. exists among the returned presets", () => {
      const preset = getScenarioPresets(products).find((p) => p.id === "buyer-bulk-request");
      expect(preset).toBeDefined();
    });

    it("2. has exactly the intended values", () => {
      const preset = getScenarioPresets(products).find((p) => p.id === "buyer-bulk-request");
      expect(preset).toMatchObject({
        id: "buyer-bulk-request",
        label: "Buyer bulk request",
        description: "The buyer offers to buy more in exchange for a lower unit price.",
        sku: "MONITOR-24-FHD",
        values: {
          sku: "MONITOR-24-FHD",
          quantity: "20",
          maxUnitPrice: "8700",
          deliveryDeadlineDays: "7",
          urgency: "high",
          deliveryFlexible: false,
        },
      });
    });

    it("5. its id does not collide with any other preset's id", () => {
      const ids = getScenarioPresets(products).map((p) => p.id);
      expect(ids.filter((id) => id === "buyer-bulk-request")).toHaveLength(1);
    });
  });

  it("3. the existing bulk-buyer preset is completely unchanged by adding buyer-bulk-request", () => {
    const preset = getScenarioPresets(products).find((p) => p.id === "bulk-buyer");
    expect(preset).toMatchObject({
      id: "bulk-buyer",
      label: "Bulk buyer",
      sku: "KEYBOARD-WIRELESS",
      values: {
        sku: "KEYBOARD-WIRELESS",
        quantity: "300",
        maxUnitPrice: "1270",
        deliveryDeadlineDays: "5",
        urgency: "high",
        deliveryFlexible: false,
      },
    });
  });

  it("4. every existing preset validation still holds with the new preset present (count, uniqueness, parseability)", () => {
    const presets = getScenarioPresets(products);
    expect(presets.length).toBeGreaterThanOrEqual(7); // 6 existing + the new one
    const ids = presets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids, including the new one
    for (const preset of presets) {
      expect(typeof parseBuyerRequestForm(preset.values)).not.toBe("string");
    }
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

  // Milestone 12.5: EXPIRED is further distinguished using rounds/maxRounds
  // — data the DTO already carries — rather than a new status enum.
  it("omitting rounds/maxRounds reproduces the exact pre-Milestone-12.5 generic EXPIRED text", () => {
    expect(negotiationFailureExplanation("EXPIRED")).toBe(
      "The maximum number of negotiation rounds was reached before both sides could agree on terms.",
    );
  });

  it("gives an early-end explanation when EXPIRED closed before the round limit (rounds < maxRounds)", () => {
    const early = negotiationFailureExplanation("EXPIRED", 2, 6);
    expect(early).toBe("Negotiation ended early — the two sides' positions could not be reconciled.");
    expect(early).not.toMatch(/maximum number of.*rounds/i);
  });

  it("gives the round-exhaustion explanation when EXPIRED closed exactly at the round limit (rounds === maxRounds)", () => {
    expect(negotiationFailureExplanation("EXPIRED", 6, 6)).toBe(
      "The maximum number of negotiation rounds was reached before both sides could agree on terms.",
    );
  });

  it("REJECTED ignores rounds/maxRounds entirely — the distinction only ever applies to EXPIRED", () => {
    expect(negotiationFailureExplanation("REJECTED", 1, 6)).toBe(
      negotiationFailureExplanation("REJECTED"),
    );
  });

  it("never mentions minPrice or any private constraint in the early-end variant either", () => {
    expect(negotiationFailureExplanation("EXPIRED", 2, 6)).not.toMatch(/minprice|floor|reservation/i);
  });
});
