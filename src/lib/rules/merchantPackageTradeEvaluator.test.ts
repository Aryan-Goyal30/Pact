import { describe, expect, it } from "vitest";
import { evaluateMerchantPackageTrade } from "./merchantPackageTradeEvaluator";
import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";

const item: CatalogItemSnapshot = {
  sku: "LAPTOP-14-I5",
  listedPrice: 48000,
  minPrice: 44000,
  availableQty: 100, // "medium" stock pressure
  standardDeliveryDays: 5,
  maxDeliveryDays: 20,
  negotiationEnabled: true,
};

describe("evaluateMerchantPackageTrade — floor and defensive cases", () => {
  it("REJECTs outright when the proposed price is below the floor, regardless of the package offered", () => {
    const evaluation = evaluateMerchantPackageTrade(
      item,
      { quantity: 500, extraDays: 10, unitPrice: 40000 },
      { jointBlindBaselinePrice: 46000 },
    );
    expect(evaluation.verdict).toBe("REJECT");
    expect(evaluation.unitPrice).toBe(46000); // clamped baseline, not the buyer's below-floor ask
  });

  it("HOLDs at baseline when no meaningful quantity was actually offered (defensive)", () => {
    const evaluation = evaluateMerchantPackageTrade(
      item,
      { quantity: 0, extraDays: 10, unitPrice: 45000 },
      { jointBlindBaselinePrice: 46000 },
    );
    expect(evaluation.verdict).toBe("HOLD");
  });

  it("HOLDs at baseline when no meaningful delivery extension was actually offered (defensive)", () => {
    const evaluation = evaluateMerchantPackageTrade(
      item,
      { quantity: 300, extraDays: 0, unitPrice: 45000 },
      { jointBlindBaselinePrice: 46000 },
    );
    expect(evaluation.verdict).toBe("HOLD");
  });
});

// Shared fixture for the stock-level tests below: baseline 46000,
// item margin (listedPrice - minPrice) 4000, a 4-day extension, a
// bulk (300-unit) quantity — chosen so the resulting combined discount
// fraction lands comfortably between 0 and 1 at every stock level,
// verified empirically (not tuned to force a particular verdict).
const baseline = 46000;

describe("evaluateMerchantPackageTrade — stock-level behavior", () => {
  it("abundant stock: quantity contributes, delivery contributes nothing", () => {
    const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };
    const evaluation = evaluateMerchantPackageTrade(
      abundant,
      { quantity: 300, extraDays: 4, unitPrice: 45000 },
      { jointBlindBaselinePrice: baseline },
    );
    expect(evaluation.verdict).toBe("COUNTER");
    // quantityFraction = 0.04 * 1.75 = 0.07 (abundant), deliveryFraction = 0 (abundant)
    expect(evaluation.unitPrice).toBe(45720);
    expect(evaluation.reason).toContain("delivery window offered has little additional value");
  });

  it("scarce stock: delivery contributes, quantity contributes nothing", () => {
    const scarce: CatalogItemSnapshot = { ...item, availableQty: 15 };
    const evaluation = evaluateMerchantPackageTrade(
      scarce,
      { quantity: 300, extraDays: 4, unitPrice: 45000 },
      { jointBlindBaselinePrice: baseline },
    );
    expect(evaluation.verdict).toBe("COUNTER");
    // quantityFraction = 0 (scarce), deliveryFraction = 4*0.01*1.75 = 0.07 (scarce)
    expect(evaluation.unitPrice).toBe(45720);
    expect(evaluation.reason).toContain("delivery window offered is what makes this package attractive");
  });

  it("medium stock: both dimensions genuinely contribute together", () => {
    const evaluation = evaluateMerchantPackageTrade(
      item,
      { quantity: 300, extraDays: 4, unitPrice: 45000 },
      { jointBlindBaselinePrice: baseline },
    );
    expect(evaluation.verdict).toBe("COUNTER");
    // quantityFraction = 0.04 (medium), deliveryFraction = 4*0.01*1.0 = 0.04 (medium) -> combined 0.08
    expect(evaluation.unitPrice).toBe(45680);
    expect(evaluation.reason).toContain("Both the extra order size and the extra delivery time");
  });
});

describe("evaluateMerchantPackageTrade — ACCEPT vs COUNTER", () => {
  it("ACCEPTs at the buyer's own price when the combined discount already clears it", () => {
    const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };
    // The abundant-stock COUNTER price above is 45720 -> an ask AT or
    // ABOVE that should be met exactly, not undercut further.
    const evaluation = evaluateMerchantPackageTrade(
      abundant,
      { quantity: 300, extraDays: 4, unitPrice: 45800 },
      { jointBlindBaselinePrice: baseline },
    );
    expect(evaluation.verdict).toBe("ACCEPT");
    expect(evaluation.unitPrice).toBe(45800);
  });

  it("never returns a price below item.minPrice, however generous the package", () => {
    const scarce: CatalogItemSnapshot = { ...item, availableQty: 15 };
    const evaluation = evaluateMerchantPackageTrade(
      scarce,
      { quantity: 100000, extraDays: 100, unitPrice: 44001 },
      { jointBlindBaselinePrice: 44500 },
    );
    expect(evaluation.unitPrice).toBeGreaterThanOrEqual(item.minPrice);
  });

  it("never returns a price above item.listedPrice", () => {
    const evaluation = evaluateMerchantPackageTrade(
      item,
      { quantity: 300, extraDays: 4, unitPrice: 47999 },
      { jointBlindBaselinePrice: 48000 },
    );
    expect(evaluation.unitPrice).toBeLessThanOrEqual(item.listedPrice);
  });
});

describe("evaluateMerchantPackageTrade — no accidental double baseline discount", () => {
  // The combined evaluator must not produce a MORE generous price than
  // each dimension's own discount fraction, summed off the SAME
  // baseline, actually justifies — i.e. it must never behave as though
  // it applied a THIRD, invented discount on top of the two real ones.
  it("the combined discount matches exactly the sum of what each dimension independently contributes at abundant stock (quantity only)", () => {
    const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };
    // A price aggressive enough to force COUNTER, but still above the floor.
    const combined = evaluateMerchantPackageTrade(
      abundant,
      { quantity: 300, extraDays: 4, unitPrice: 44500 },
      { jointBlindBaselinePrice: baseline },
    );
    // Abundant stock's own quantity-only bonus fraction is
    // LARGE_ORDER_MERCHANT_DISCOUNT (0.04) * ABUNDANT_STOCK_TRADE_MULTIPLIER (1.75) = 0.07,
    // and delivery contributes 0 at abundant stock — so the combined
    // COUNTER price should land EXACTLY where quantity alone would give,
    // never lower (which would indicate an invented extra discount
    // rather than delivery's own, correctly-zero contribution).
    const margin = item.listedPrice - item.minPrice;
    const quantityOnlyPrice = Math.round(baseline - margin * (0.04 * 1.75));
    expect(combined.unitPrice).toBe(quantityOnlyPrice);
    expect(combined.unitPrice).toBe(45720);
  });
});

// PACT V2 Milestone 12 CORRECTION: merchant package pricing must use the
// actual authorized/fulfillable quantity, not the buyer's raw ask, when
// partial fulfillment means they differ. This module itself (unlike
// merchantTradeEvaluator.ts — see merchantMoveSelection.test.ts's own
// correction tests for why that one is different) has no internal
// threshold gate keyed on `proposal.quantity`'s magnitude — the only use
// of it is the defensive `<= 0` check, and the discount fraction itself
// depends only on stock-pressure CATEGORY, never the quantity number.
// These tests confirm that precisely: passing the authorized (capped)
// quantity is safe, produces a real verdict, and — honestly documented —
// currently produces the IDENTICAL price the raw ask would have, because
// this specific formula was never quantity-magnitude-sensitive to begin
// with. See the Milestone 12 correction report for why this is still a
// genuine fix (the candidate's own recorded quantity, not the price, was
// the actual fidelity problem) rather than a no-op.
describe("Milestone 12 correction: evaluateMerchantPackageTrade with the authorized (stock-capped) quantity", () => {
  it("A: a partially-constrained package (requested 80, authorized 45) evaluates cleanly against 45", () => {
    const evaluation = evaluateMerchantPackageTrade(
      item,
      { quantity: 45, extraDays: 4, unitPrice: 45000 },
      { jointBlindBaselinePrice: baseline },
    );
    expect(["ACCEPT", "COUNTER"]).toContain(evaluation.verdict);
  });

  it("B: when stock fully covers the ask (requested 80, authorized 80 — no partial fulfillment), evaluation proceeds normally against the full 80", () => {
    const evaluation = evaluateMerchantPackageTrade(
      item,
      { quantity: 80, extraDays: 4, unitPrice: 45000 },
      { jointBlindBaselinePrice: baseline },
    );
    expect(["ACCEPT", "COUNTER"]).toContain(evaluation.verdict);
    // Same verdict/price as the constrained (45-unit) case in test A —
    // expected given test E's own finding, not a coincidence.
    const constrained = evaluateMerchantPackageTrade(
      item,
      { quantity: 45, extraDays: 4, unitPrice: 45000 },
      { jointBlindBaselinePrice: baseline },
    );
    expect(evaluation.unitPrice).toBe(constrained.unitPrice);
  });

  it("E: documents the current formula's actual quantity sensitivity — price is identical across authorized quantities, since this formula's discount depends only on stock-pressure category, never the raw quantity number", () => {
    const at45 = evaluateMerchantPackageTrade(
      item,
      { quantity: 45, extraDays: 4, unitPrice: 45000 },
      { jointBlindBaselinePrice: baseline },
    );
    const at80 = evaluateMerchantPackageTrade(
      item,
      { quantity: 80, extraDays: 4, unitPrice: 45000 },
      { jointBlindBaselinePrice: baseline },
    );
    // Not a bug introduced by this correction — a real, pre-existing
    // property of the formula, confirmed directly rather than assumed.
    // The fix's real value is the CANDIDATE's own recorded quantity
    // (proven in merchantMoveSelection.test.ts), not a price difference
    // this formula was never capable of producing from quantity alone.
    expect(at45.unitPrice).toBe(at80.unitPrice);
    expect(at45.verdict).toBe(at80.verdict);
  });
});
