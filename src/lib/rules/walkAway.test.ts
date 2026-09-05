import { describe, expect, it } from "vitest";
import { arePositionsRepeated, isPriceGapUnbridgeable } from "./walkAway";

describe("isPriceGapUnbridgeable", () => {
  it("is true when the buyer's ceiling is below the merchant's floor on a negotiable item", () => {
    expect(
      isPriceGapUnbridgeable({ minPrice: 44000, negotiationEnabled: true }, { maxUnitPrice: 30000 }),
    ).toBe(true);
  });

  it("is false when the buyer's ceiling meets or exceeds the floor", () => {
    expect(
      isPriceGapUnbridgeable({ minPrice: 44000, negotiationEnabled: true }, { maxUnitPrice: 44000 }),
    ).toBe(false);
    expect(
      isPriceGapUnbridgeable({ minPrice: 44000, negotiationEnabled: true }, { maxUnitPrice: 50000 }),
    ).toBe(false);
  });

  // Must never interfere with the existing REJECTED path for non-negotiable items.
  it("is false for a non-negotiable item regardless of the price gap", () => {
    expect(
      isPriceGapUnbridgeable({ minPrice: 44000, negotiationEnabled: false }, { maxUnitPrice: 30000 }),
    ).toBe(false);
  });

  // Pass 4: budgetFlexible / effectiveCeiling.
  describe("Pass 4 — budgetFlexible", () => {
    it("a hard budget below the merchant floor still structurally walks away, unchanged", () => {
      expect(
        isPriceGapUnbridgeable(
          { minPrice: 44000, negotiationEnabled: true },
          { maxUnitPrice: 30000, budgetFlexible: false },
        ),
      ).toBe(true);
    });

    it("a flexible budget below the merchant floor does NOT structurally walk away when the listed price covers the floor", () => {
      expect(
        isPriceGapUnbridgeable(
          { minPrice: 44000, negotiationEnabled: true, listedPrice: 48000 },
          { maxUnitPrice: 30000, budgetFlexible: true },
        ),
      ).toBe(false);
    });

    it("a flexible budget remains bounded — still walks away when even the listed price is below the merchant floor", () => {
      expect(
        isPriceGapUnbridgeable(
          { minPrice: 44000, negotiationEnabled: true, listedPrice: 40000 },
          { maxUnitPrice: 30000, budgetFlexible: true },
        ),
      ).toBe(true);
    });

    it("a flexible budget with no listedPrice available falls back to the stated maxUnitPrice (still walks away)", () => {
      expect(
        isPriceGapUnbridgeable(
          { minPrice: 44000, negotiationEnabled: true },
          { maxUnitPrice: 30000, budgetFlexible: true },
        ),
      ).toBe(true);
    });
  });
});

describe("arePositionsRepeated", () => {
  it("is true when both sides' prices exactly match the previous round", () => {
    expect(
      arePositionsRepeated(
        { buyerUnitPrice: 30000, merchantUnitPrice: 44000 },
        { buyerUnitPrice: 30000, merchantUnitPrice: 44000 },
      ),
    ).toBe(true);
  });

  it("is false when either side moved even slightly", () => {
    expect(
      arePositionsRepeated(
        { buyerUnitPrice: 30001, merchantUnitPrice: 44000 },
        { buyerUnitPrice: 30000, merchantUnitPrice: 44000 },
      ),
    ).toBe(false);
    expect(
      arePositionsRepeated(
        { buyerUnitPrice: 30000, merchantUnitPrice: 43999 },
        { buyerUnitPrice: 30000, merchantUnitPrice: 44000 },
      ),
    ).toBe(false);
  });

  it("is false when there is no previous round to compare against (opening round)", () => {
    expect(
      arePositionsRepeated(
        { buyerUnitPrice: 30000, merchantUnitPrice: 44000 },
        { buyerUnitPrice: undefined, merchantUnitPrice: undefined },
      ),
    ).toBe(false);
    expect(
      arePositionsRepeated(
        { buyerUnitPrice: 30000, merchantUnitPrice: 44000 },
        { buyerUnitPrice: null, merchantUnitPrice: null },
      ),
    ).toBe(false);
  });

  it("is false when either side's current price is null (e.g. a reject)", () => {
    expect(
      arePositionsRepeated(
        { buyerUnitPrice: null, merchantUnitPrice: 44000 },
        { buyerUnitPrice: 30000, merchantUnitPrice: 44000 },
      ),
    ).toBe(false);
  });
});
