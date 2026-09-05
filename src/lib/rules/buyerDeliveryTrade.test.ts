import { describe, expect, it } from "vitest";
import { decideBuyerDeliveryTrade } from "./buyerDeliveryTrade";
import type { BuyerConstraints } from "./buyerRules";

const constraints: BuyerConstraints = {
  sku: "LAPTOP-14-I5",
  quantity: 40,
  maxUnitPrice: 45500,
  deliveryDeadlineDays: 8,
  urgency: "high",
  deliveryFlexible: true,
};
const concessionContext = { round: 2, maxRounds: 10 };
// The real LAPTOP-14-I5 maxDeliveryDays.
//
// Negotiation calibration audit: with urgency now affecting the
// delivery-extension willingness (resolveDeliveryUrgencyFactor), the
// base fixture's own "high" urgency means its computed extension is
// 8 + round(8*0.3) = 10, genuinely BELOW this ceiling — every test in
// this file that reuses `constraints` unchanged now exercises the
// "computed <= maxDeliveryDays, unclamped" case at THAT (urgency-
// dependent) number, not 12. The clamp itself, and the urgency-driven
// differentiation, are both covered explicitly further below.
const maxDeliveryDays = 12;

describe("decideBuyerDeliveryTrade", () => {
  // Buyer can identify a useful delivery-for-price opportunity.
  it("proposes DELIVERY_FOR_PRICE with a real price gap and rounds to spare", () => {
    const decision = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, 26, false, maxDeliveryDays);
    expect(decision.move).toBe("DELIVERY_FOR_PRICE");
    // 8 + round(8 * 0.3) = 10 — resolveDeliveryUrgencyFactor("high") = 0.3.
    // Price is untouched by this: still the same real, empirically
    // verified value (price computation never reads deliveryDays).
    expect(decision.deliveryDays).toBe(10);
    expect(decision.unitPrice).toBe(44255);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  describe("does not trade when conditions are not useful", () => {
    it("the buyer has not indicated any delivery flexibility", () => {
      const inflexible: BuyerConstraints = { ...constraints, deliveryFlexible: false };
      const decision = decideBuyerDeliveryTrade(inflexible, 46209, concessionContext, undefined, 26, false, maxDeliveryDays);
      expect(decision.move).toBe("NO_TRADE");
      expect(decision.reason).toContain("flexibility");
    });

    it("too few rounds remain (final-two-round safety net)", () => {
      const decision = decideBuyerDeliveryTrade(constraints, 46209, { round: 9, maxRounds: 10 }, undefined, 26, false, maxDeliveryDays);
      expect(decision.move).toBe("NO_TRADE");
    });

    it("the chip has already been used earlier in this negotiation", () => {
      const decision = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, 26, true, maxDeliveryDays);
      expect(decision.move).toBe("NO_TRADE");
      expect(decision.reason).toContain("already used");
    });

    it("no real price gap remains (merchant's offer is already at or below target)", () => {
      const decision = decideBuyerDeliveryTrade(constraints, 43000, concessionContext, undefined, 26, false, maxDeliveryDays);
      expect(decision.move).toBe("NO_TRADE");
    });

    it("no leverage signal at all — never defaults to eligible", () => {
      const decision = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, undefined, false, maxDeliveryDays);
      expect(decision.move).toBe("NO_TRADE");
    });
  });

  // Leverage sizes the ask, never gates eligibility — same Milestone 6
  // correction applied to this dimension from day one, not retrofitted.
  describe("leverage modulates the size of the ask, never eligibility", () => {
    it("a high-leverage buyer CAN still trade delivery, and asks for a bigger discount than a moderate-leverage buyer", () => {
      const moderate = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, 26, false, maxDeliveryDays);
      const strong = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, 90, false, maxDeliveryDays);

      expect(moderate.move).toBe("DELIVERY_FOR_PRICE");
      expect(strong.move).toBe("DELIVERY_FOR_PRICE");
      expect(strong.unitPrice!).toBeLessThan(moderate.unitPrice!);
    });

    it("a low-leverage buyer also trades, with a more modest ask", () => {
      const weak = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, 20, false, maxDeliveryDays);
      const strong = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, 90, false, maxDeliveryDays);

      expect(weak.move).toBe("DELIVERY_FOR_PRICE");
      expect(weak.unitPrice!).toBeGreaterThan(strong.unitPrice!);
    });
  });

  // Buyer never proposes an unreasonable delivery extension.
  it("proposes a bounded delivery extension — a fraction of the original deadline (urgency-scaled), not an arbitrary number", () => {
    const decision = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, 26, false, maxDeliveryDays);
    expect(decision.deliveryDays).toBe(10); // 8 + 2, per resolveDeliveryUrgencyFactor("high") = 0.3
    expect(decision.deliveryDays!).toBeGreaterThan(constraints.deliveryDeadlineDays);
    expect(decision.deliveryDays!).toBeLessThan(constraints.deliveryDeadlineDays * 3); // bounded
  });

  // Buyer remains within maxUnitPrice.
  it("never proposes a price above the buyer's hard ceiling, even with an extreme merchant offer", () => {
    const decision = decideBuyerDeliveryTrade(constraints, 100000, concessionContext, undefined, 26, false, maxDeliveryDays);
    if (decision.move === "DELIVERY_FOR_PRICE") {
      expect(decision.unitPrice!).toBeLessThanOrEqual(constraints.maxUnitPrice);
    }
  });

  // Buyer does not repeat the same trade indefinitely.
  it("respects deliveryTradeAlreadyUsed even when every other condition is favorable", () => {
    const decision = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, 26, true, maxDeliveryDays);
    expect(decision.move).toBe("NO_TRADE");
  });

  // ---------------------------------------------------------------------
  // PACT — Buyer delivery-trade ceiling fix (negotiation hardening audit,
  // finding B/C: "12 -> 18" over-ceiling ask). Focused regression tests,
  // per that task's own required cases A/B/C/E.
  // ---------------------------------------------------------------------
  describe("maxDeliveryDays ceiling (negotiation hardening fix)", () => {
    // A. deadline 12, max 12 -> trade must NOT produce 18, for every urgency.
    it("A: deadline=12, maxDeliveryDays=12 — never proposes 18, and correctly finds no valid delivery give (every urgency)", () => {
      for (const urgency of ["low", "medium", "high"] as const) {
        const atCeiling: BuyerConstraints = { ...constraints, deliveryDeadlineDays: 12, urgency };
        const decision = decideBuyerDeliveryTrade(atCeiling, 46209, concessionContext, undefined, 26, false, 12);
        expect(decision.deliveryDays).not.toBe(18);
        // Regardless of urgency's own factor, clamping to maxDeliveryDays
        // (12) == the buyer's own deadline (12) -> no real extension left
        // -> not a valid delivery give.
        expect(decision.move).toBe("NO_TRADE");
        expect(decision.reason).toContain("maximum delivery window");
      }
    });

    // B. deadline 8, max 12 (urgency=high, from the base fixture) ->
    // computed 10 is already within the ceiling, unchanged by the clamp.
    it("B: deadline=8, maxDeliveryDays=12 — computed 10 (high urgency) is already within the ceiling, unclamped", () => {
      const decision = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, 26, false, 12);
      expect(decision.move).toBe("DELIVERY_FOR_PRICE");
      expect(decision.deliveryDays).toBe(10);
    });

    // C. deadline 7, max 10, MEDIUM urgency -> computed 11 (7+round(7*0.5))
    // is clamped to 10 — the original ceiling-fix regression, pinned at
    // medium urgency specifically so this test's own clamp-exercising
    // intent stays exactly what it always was, independent of the new
    // urgency dimension (see "E" below for urgency's OWN near-ceiling behavior).
    it("C: deadline=7, maxDeliveryDays=10, medium urgency — computed 11 is clamped to 10", () => {
      const tight: BuyerConstraints = { ...constraints, deliveryDeadlineDays: 7, urgency: "medium" };
      const decision = decideBuyerDeliveryTrade(tight, 46209, concessionContext, undefined, 26, false, 10);
      expect(decision.move).toBe("DELIVERY_FOR_PRICE");
      expect(decision.deliveryDays).toBe(10);
      expect(decision.deliveryDays!).toBeLessThanOrEqual(10);
    });

    // E. near ceiling: maxDeliveryDays still wins over the urgency
    // factor — deadline=9/max=10 is close enough that even HIGH urgency's
    // smaller raw ask (9+round(9*0.3)=12) still exceeds the ceiling, so
    // all three urgency levels converge on the SAME clamped value.
    it("E: near ceiling (deadline=9, max=10) — every urgency level converges on the same clamped deliveryDays", () => {
      const low: BuyerConstraints = { ...constraints, deliveryDeadlineDays: 9, urgency: "low" };
      const medium: BuyerConstraints = { ...constraints, deliveryDeadlineDays: 9, urgency: "medium" };
      const high: BuyerConstraints = { ...constraints, deliveryDeadlineDays: 9, urgency: "high" };
      const lowResult = decideBuyerDeliveryTrade(low, 46209, concessionContext, undefined, 26, false, 10);
      const mediumResult = decideBuyerDeliveryTrade(medium, 46209, concessionContext, undefined, 26, false, 10);
      const highResult = decideBuyerDeliveryTrade(high, 46209, concessionContext, undefined, 26, false, 10);
      expect(lowResult.deliveryDays).toBe(10);
      expect(mediumResult.deliveryDays).toBe(10);
      expect(highResult.deliveryDays).toBe(10);
      // Prices still differ only by leverage/urgency's OWN price effects
      // (unrelated to this fix) — never by the delivery clamp itself.
    });

    // A valid delivery trade genuinely below the ceiling is unaffected by
    // the ceiling fix itself (a generous vs. effectively-infinite max
    // produce identical output) — independent of which urgency is used.
    it("a valid trade genuinely below the ceiling (deadline=8, max=20) is completely unaffected by the ceiling fix", () => {
      const generous = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, 26, false, 20);
      const unclamped = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, 26, false, Number.POSITIVE_INFINITY);
      expect(generous).toEqual(unclamped);
      expect(generous.deliveryDays).toBe(10); // the same real, un-clamped 8+2 (high urgency)
    });
  });

  // ---------------------------------------------------------------------
  // PACT — Urgency-calibrated delivery flexibility (negotiation
  // calibration task). resolveDeliveryUrgencyFactor: LOW=0.70,
  // MEDIUM=0.50 (baseline, unchanged), HIGH=0.30.
  // ---------------------------------------------------------------------
  describe("urgency-calibrated delivery extension", () => {
    const comfortable: Omit<BuyerConstraints, "urgency"> = { ...constraints, deliveryDeadlineDays: 6 };

    // A. LOW produces more delivery slack than MEDIUM when the ceiling allows it.
    it("A: LOW urgency (factor 0.70) offers more delivery slack than MEDIUM, when the ceiling allows it", () => {
      const low = decideBuyerDeliveryTrade({ ...comfortable, urgency: "low" }, 46209, concessionContext, undefined, 26, false, 12);
      const medium = decideBuyerDeliveryTrade({ ...comfortable, urgency: "medium" }, 46209, concessionContext, undefined, 26, false, 12);
      expect(low.move).toBe("DELIVERY_FOR_PRICE");
      expect(medium.move).toBe("DELIVERY_FOR_PRICE");
      expect(low.deliveryDays).toBe(10); // 6 + round(6*0.7) = 10
      expect(medium.deliveryDays).toBe(9); // 6 + round(6*0.5) = 9
      expect(low.deliveryDays!).toBeGreaterThan(medium.deliveryDays!);
    });

    // B. MEDIUM (0.50) preserves the exact pre-calibration baseline.
    it("B: MEDIUM urgency (factor 0.50) reproduces the exact pre-existing DELIVERY_TRADE_EXTENSION_FRACTION behavior", () => {
      const medium = decideBuyerDeliveryTrade({ ...comfortable, urgency: "medium" }, 46209, concessionContext, undefined, 26, false, 12);
      expect(medium.deliveryDays).toBe(9); // 6 + round(6 * 0.5), identical to the formula before this task
    });

    // C. HIGH produces less delivery slack than MEDIUM when the ceiling allows it.
    it("C: HIGH urgency (factor 0.30) offers less delivery slack than MEDIUM, when the ceiling allows it", () => {
      const high = decideBuyerDeliveryTrade({ ...comfortable, urgency: "high" }, 46209, concessionContext, undefined, 26, false, 12);
      const medium = decideBuyerDeliveryTrade({ ...comfortable, urgency: "medium" }, 46209, concessionContext, undefined, 26, false, 12);
      expect(high.move).toBe("DELIVERY_FOR_PRICE");
      expect(high.deliveryDays).toBe(8); // 6 + round(6*0.3) = 8
      expect(high.deliveryDays!).toBeLessThan(medium.deliveryDays!);
    });

    // D. deadline == maxDeliveryDays -> NO_TRADE, for LOW/MEDIUM/HIGH alike.
    it("D: deadline == maxDeliveryDays produces NO_TRADE for every urgency level", () => {
      for (const urgency of ["low", "medium", "high"] as const) {
        const atCeiling: BuyerConstraints = { ...comfortable, deliveryDeadlineDays: 12, urgency };
        const decision = decideBuyerDeliveryTrade(atCeiling, 46209, concessionContext, undefined, 26, false, 12);
        expect(decision.move).toBe("NO_TRADE");
      }
    });

    // G. Price computation is completely unaffected by THIS change — i.e.
    // by the resulting deliveryDays value itself (never by urgency in
    // general: urgency has ALWAYS also affected price, via the separate,
    // pre-existing resolveUrgencyConcessionFactor inside
    // computeBuyerConcessionPrice — that mechanism is untouched and out
    // of scope here). Holding urgency fixed and only varying
    // maxDeliveryDays (so deliveryDays itself genuinely differs, clamped
    // vs. not) isolates exactly that claim.
    it("G: unitPrice is identical regardless of the resulting deliveryDays value (clamped or not) — price never reads deliveryDays", () => {
      const unclamped = decideBuyerDeliveryTrade({ ...comfortable, urgency: "low" }, 46209, concessionContext, undefined, 26, false, 20);
      const clamped = decideBuyerDeliveryTrade({ ...comfortable, urgency: "low" }, 46209, concessionContext, undefined, 26, false, 9);
      expect(unclamped.deliveryDays).not.toBe(clamped.deliveryDays); // genuinely different deliveryDays...
      expect(unclamped.unitPrice).toBe(clamped.unitPrice); // ...but identical price
    });

    // I. Urgency has no effect at all when deliveryFlexible=false — the
    // eligibility gate stays structurally disabled regardless.
    it("I: deliveryFlexible=false stays NO_TRADE for every urgency level, unaffected by the new factor", () => {
      for (const urgency of ["low", "medium", "high"] as const) {
        const inflexible: BuyerConstraints = { ...comfortable, deliveryFlexible: false, urgency };
        const decision = decideBuyerDeliveryTrade(inflexible, 46209, concessionContext, undefined, 26, false, 12);
        expect(decision.move).toBe("NO_TRADE");
        expect(decision.reason).toContain("flexibility");
      }
    });
  });

  // Negotiation Engine V2 (D5): the trade's price must never exceed the
  // buyer's own previous round's price — mirroring the exact invariant
  // already proven for buyerQuantityTrade.ts / buyerQuantityAndDeliveryTrade.ts.
  // Test requirement #8.
  describe("previousBuyerUnitPrice invariant (D5)", () => {
    it("omitting it reproduces the exact price from before this parameter existed", () => {
      const decision = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, 26, false, maxDeliveryDays);
      expect(decision.unitPrice).toBe(44255);
    });

    it("clamps the trade price down when the raw discount math would otherwise ask for more than the buyer's own previous price", () => {
      const unclamped = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, 26, false, maxDeliveryDays);
      const clamped = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, 43000, 26, false, maxDeliveryDays);
      expect(unclamped.unitPrice).toBeGreaterThan(43000); // confirms the clamp is genuinely binding here
      expect(clamped.move).toBe("DELIVERY_FOR_PRICE"); // still a real trade — only the price is bounded, not eligibility
      expect(clamped.unitPrice).toBe(43000);
      expect(clamped.unitPrice!).toBeLessThanOrEqual(43000);
    });

    it("has no effect when the buyer's own previous price is already above what the raw discount math would ask for", () => {
      const withoutPrevious = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, undefined, 26, false, maxDeliveryDays);
      const withLoosePrevious = decideBuyerDeliveryTrade(constraints, 46209, concessionContext, 45000, 26, false, maxDeliveryDays);
      expect(withLoosePrevious.unitPrice).toBe(withoutPrevious.unitPrice); // genuinely a no-op — the ordinary bound already governs
    });

    it("never exceeds maxUnitPrice even when previousBuyerUnitPrice is set above it", () => {
      const decision = decideBuyerDeliveryTrade(constraints, 100000, concessionContext, 999999, 26, false, maxDeliveryDays);
      if (decision.move === "DELIVERY_FOR_PRICE") {
        expect(decision.unitPrice!).toBeLessThanOrEqual(constraints.maxUnitPrice);
      }
    });
  });
});

// ---------------------------------------------------------------------
// Pass 6: budgetFlexible consistency — effectiveCeiling threading.
// ---------------------------------------------------------------------
describe("decideBuyerDeliveryTrade — Pass 6: effectiveCeiling", () => {
  // E. Hard budget (effectiveCeiling omitted, or explicitly equal to
  // maxUnitPrice) reproduces byte-identical behavior.
  it("E: omitting effectiveCeiling and passing it equal to maxUnitPrice produce identical results", () => {
    const omitted = decideBuyerDeliveryTrade(constraints, 100000, concessionContext, undefined, 26, false, maxDeliveryDays);
    const explicitMax = decideBuyerDeliveryTrade(
      constraints,
      100000,
      concessionContext,
      undefined,
      26,
      false,
      maxDeliveryDays,
      constraints.maxUnitPrice,
    );
    expect(explicitMax).toEqual(omitted);
  });

  // D. A flexible buyer's trade can reach a higher effectiveCeiling than
  // its stated maxUnitPrice — same saturation technique as
  // buyerQuantityTrade.test.ts's own Pass 6 tests: an extreme merchant
  // offer with no previousBuyerUnitPrice forces normalAsk to saturate at
  // whichever ceiling is given.
  it("D: a higher effectiveCeiling raises the trade's own price ceiling above the hard maxUnitPrice", () => {
    const flexibleCeiling = 52000; // above constraints.maxUnitPrice (45500)
    const hard = decideBuyerDeliveryTrade(constraints, 200000, concessionContext, undefined, 26, false, maxDeliveryDays);
    const flexible = decideBuyerDeliveryTrade(
      constraints,
      200000,
      concessionContext,
      undefined,
      26,
      false,
      maxDeliveryDays,
      flexibleCeiling,
    );
    expect(hard.move).toBe("DELIVERY_FOR_PRICE");
    expect(flexible.move).toBe("DELIVERY_FOR_PRICE");
    expect(hard.unitPrice!).toBeLessThanOrEqual(constraints.maxUnitPrice);
    expect(flexible.unitPrice!).toBeLessThanOrEqual(flexibleCeiling);
    expect(flexible.unitPrice!).toBeGreaterThan(hard.unitPrice!);
  });

  it("D: still respects previousBuyerUnitPrice as the tighter of the two bounds, even when effectiveCeiling is higher", () => {
    const decision = decideBuyerDeliveryTrade(
      constraints,
      200000,
      concessionContext,
      46800, // the buyer's own prior offer — below the flexible ceiling
      26,
      false,
      maxDeliveryDays,
      52000,
    );
    if (decision.move === "DELIVERY_FOR_PRICE") {
      expect(decision.unitPrice!).toBeLessThanOrEqual(46800);
    }
  });
});
