// Tests for the merchant's conditional quantity <-> price trade
// evaluator. Exercises evaluateMerchantTrade directly, with hand-picked
// baselineConcessionPrice values so each scenario is fully controlled —
// the same convention computeMerchantConcessionPrice's own tests use.

import { describe, expect, it } from "vitest";
import { evaluateMerchantTrade, type MerchantTradeContext } from "./merchantTradeEvaluator";
import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import { LARGE_ORDER_QUANTITY_THRESHOLD } from "@/lib/rules/negotiationStrategy";

type Item = Pick<CatalogItemSnapshot, "minPrice" | "listedPrice" | "availableQty">;

const laptop: Item = { minPrice: 44000, listedPrice: 48000, availableQty: 100 }; // medium stock band

function ctx(baselineConcessionPrice: number): MerchantTradeContext {
  return { baselineConcessionPrice };
}

describe("evaluateMerchantTrade — hard constraints", () => {
  // 3. Proposed price below minPrice is never accepted, at any quantity.
  it("rejects a below-floor price regardless of how large the order is", () => {
    const evaluation = evaluateMerchantTrade(
      laptop,
      { quantity: 10000, unitPrice: 40000 }, // well below the 44000 floor
      ctx(45000),
    );
    expect(evaluation.verdict).toBe("REJECT");
    expect(evaluation.unitPrice).toBeGreaterThanOrEqual(laptop.minPrice);
  });

  it("never returns a price below minPrice or above listedPrice, across every verdict", () => {
    const cases: Array<[Item, number, number, number]> = [
      [{ ...laptop, availableQty: 1000 }, 5000, 30000, 30000], // abundant stock, absurdly low baseline+ask
      [{ ...laptop, availableQty: 10 }, 5000, 90000, 90000], // scarce stock, absurdly high ask
      [laptop, 10, 100000, 100000], // below threshold, huge numbers
    ];
    for (const [item, quantity, unitPrice, baseline] of cases) {
      const evaluation = evaluateMerchantTrade(item, { quantity, unitPrice }, ctx(baseline));
      expect(evaluation.unitPrice).toBeGreaterThanOrEqual(item.minPrice);
      expect(evaluation.unitPrice).toBeLessThanOrEqual(item.listedPrice);
    }
  });
});

describe("evaluateMerchantTrade — quantity below the bulk threshold", () => {
  it("passes the baseline through unchanged when quantity doesn't cross the leverage threshold", () => {
    const evaluation = evaluateMerchantTrade(laptop, { quantity: 10, unitPrice: 45000 }, ctx(45750));
    expect(evaluation.verdict).toBe("COUNTER");
    expect(evaluation.unitPrice).toBe(45750);
  });
});

describe("evaluateMerchantTrade — stock-dependent bulk-order behavior", () => {
  const bulkQuantity = LARGE_ORDER_QUANTITY_THRESHOLD;

  // Scenario A (abundant stock): the same large order is genuinely
  // attractive enough to justify a real discount off the baseline.
  it("abundant stock: a large order discounts meaningfully below the baseline", () => {
    const abundant: Item = { ...laptop, availableQty: 1000 };
    const evaluation = evaluateMerchantTrade(abundant, { quantity: bulkQuantity, unitPrice: 44100 }, ctx(45600));
    expect(["ACCEPT", "COUNTER"]).toContain(evaluation.verdict);
    expect(evaluation.unitPrice).toBeLessThan(45600);
  });

  // Scenario B (scarce stock): the SAME order size and SAME baseline
  // produce a materially different (less generous) outcome — this is
  // the core "not a universal rule" requirement.
  it("scarce stock: the identical order produces a materially different (less generous) decision than abundant stock", () => {
    const scarce: Item = { ...laptop, availableQty: 15 };
    const abundant: Item = { ...laptop, availableQty: 1000 };
    const scarceResult = evaluateMerchantTrade(scarce, { quantity: bulkQuantity, unitPrice: 44100 }, ctx(45600));
    const abundantResult = evaluateMerchantTrade(abundant, { quantity: bulkQuantity, unitPrice: 44100 }, ctx(45600));

    expect(scarceResult.verdict).toBe("HOLD");
    expect(scarceResult.unitPrice).toBe(45600); // no discount granted at all
    expect(abundantResult.unitPrice).toBeLessThan(scarceResult.unitPrice);
  });

  // 5. Larger quantity does NOT universally imply a lower price.
  it("a large order against scarce stock does not receive a lower price than the baseline", () => {
    const scarce: Item = { ...laptop, availableQty: 20 };
    const evaluation = evaluateMerchantTrade(scarce, { quantity: bulkQuantity, unitPrice: 44500 }, ctx(46000));
    expect(evaluation.unitPrice).toBe(46000);
    expect(evaluation.verdict).toBe("HOLD");
  });

  // 6. A sufficiently attractive quantity/price combination can justify
  // a merchant concession that fully meets the buyer's ask.
  it("abundant stock + a generous-enough buyer ask produces ACCEPT at the buyer's price", () => {
    const abundant: Item = { ...laptop, availableQty: 5000 };
    const evaluation = evaluateMerchantTrade(abundant, { quantity: bulkQuantity, unitPrice: 45500 }, ctx(45600));
    expect(evaluation.verdict).toBe("ACCEPT");
    expect(evaluation.unitPrice).toBe(45500);
  });

  // 7. An unattractive combination can be rejected/held rather than granted.
  it("scarce stock never produces ACCEPT purely from order size", () => {
    const scarce: Item = { ...laptop, availableQty: 10 };
    const evaluation = evaluateMerchantTrade(scarce, { quantity: bulkQuantity, unitPrice: 44050 }, ctx(45000));
    expect(evaluation.verdict).not.toBe("ACCEPT");
  });

  // 8. A borderline combination can produce a COUNTER — better than the
  // baseline, but not a full concession to the buyer's ask.
  it("medium stock with a moderate ask produces a COUNTER strictly between the buyer's ask and the baseline", () => {
    const medium: Item = { ...laptop, availableQty: 100 };
    const evaluation = evaluateMerchantTrade(medium, { quantity: bulkQuantity, unitPrice: 44200 }, ctx(45600));
    expect(evaluation.verdict).toBe("COUNTER");
    expect(evaluation.unitPrice).toBeLessThan(45600);
    expect(evaluation.unitPrice).toBeGreaterThan(44200);
  });

  it("medium stock's bonus matches the existing LARGE_ORDER_MERCHANT_DISCOUNT calibration exactly", () => {
    // margin = 48000-44000 = 4000; 4000*0.04 = 160 -> 45600-160 = 45440.
    // Buyer's ask (44200) stays below that traded price, so this is a
    // genuine COUNTER, not an ACCEPT — isolates the calibration math.
    const evaluation = evaluateMerchantTrade(laptop, { quantity: bulkQuantity, unitPrice: 44200 }, ctx(45600));
    expect(evaluation.unitPrice).toBe(45440);
    expect(evaluation.verdict).toBe("COUNTER");
  });
});

describe("evaluateMerchantTrade — reasons", () => {
  it("every verdict carries a non-empty, number-free reason", () => {
    const fixtures: Array<[Item, MerchantTradeContext, { quantity: number; unitPrice: number }]> = [
      [laptop, ctx(45000), { quantity: 40000, unitPrice: 40000 }], // REJECT
      [laptop, ctx(45750), { quantity: 10, unitPrice: 45000 }], // COUNTER (below threshold)
      [{ ...laptop, availableQty: 10 }, ctx(45600), { quantity: 300, unitPrice: 44100 }], // HOLD
      [{ ...laptop, availableQty: 5000 }, ctx(45600), { quantity: 300, unitPrice: 45500 }], // ACCEPT
    ];
    for (const [item, context, proposal] of fixtures) {
      const evaluation = evaluateMerchantTrade(item, proposal, context);
      expect(evaluation.reason.length).toBeGreaterThan(0);
      expect(/\d/.test(evaluation.reason)).toBe(false);
    }
  });
});
