import { describe, expect, it } from "vitest";
import { decideBuyerQuantityTrade } from "./buyerQuantityTrade";
import { resolveQuantityTradeIncreaseFraction, resolveQuantityTradePriceImprovementFraction } from "./negotiationStrategy";
import type { BuyerConstraints } from "./buyerRules";

const constraints: BuyerConstraints = {
  sku: "LAPTOP-14-I5",
  quantity: 50,
  maxUnitPrice: 45500,
  deliveryDeadlineDays: 10,
  urgency: "high",
};
const concessionContext = { round: 2, maxRounds: 10 };

describe("decideBuyerQuantityTrade", () => {
  // 1. Buyer can identify a useful quantity-for-price opportunity.
  it("proposes QUANTITY_FOR_PRICE with a real quantity increase and a price at/below the buyer's own target", () => {
    const decision = decideBuyerQuantityTrade(
      constraints,
      45613, // merchant's current offer — above the buyer's target (43225)
      50, // merchant fully supplied the original request
      concessionContext,
      null,
      null, // no previous buyer price on record for this fixture
      54, // moderate leverage
      false,
    );
    expect(decision.move).toBe("QUANTITY_FOR_PRICE");
    // Verified by actually running the real resolver (Buyer Quantity-for-
    // Price Redesign) — not hand-derived. LAPTOP's high per-unit price
    // pulls the increase fraction to its floor (0.15) for this base
    // quantity; the discounted price undercuts the buyer's own target
    // (43225), so it clamps there rather than going any lower.
    expect(decision.quantity).toBe(57);
    expect(decision.unitPrice).toBe(43225);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  // 2. Buyer does NOT use the quantity chip when conditions are not useful.
  describe("does not trade when conditions are not useful", () => {
    it("too few rounds remain (final-two-round safety net)", () => {
      const decision = decideBuyerQuantityTrade(
        constraints,
        45613,
        50,
        { round: 9, maxRounds: 10 },
        null,
        null,
        54,
        false,
      );
      expect(decision.move).toBe("NO_TRADE");
    });

    it("the chip has already been used earlier in this negotiation", () => {
      const decision = decideBuyerQuantityTrade(constraints, 45613, 50, concessionContext, null, null, 54, true);
      expect(decision.move).toBe("NO_TRADE");
    });

    it("the merchant is already short-supplying the original request", () => {
      const decision = decideBuyerQuantityTrade(
        constraints,
        45613,
        30, // less than constraints.quantity (50) — already stock-constrained
        concessionContext,
        null,
        null,
        54,
        false,
      );
      expect(decision.move).toBe("NO_TRADE");
    });

    it("no real price gap remains (merchant's offer is already at or below target)", () => {
      const decision = decideBuyerQuantityTrade(
        constraints,
        43000, // below the buyer's own target (43225)
        50,
        concessionContext,
        null,
        null,
        54,
        false,
      );
      expect(decision.move).toBe("NO_TRADE");
    });

    it("no leverage signal at all — never defaults to eligible", () => {
      const decision = decideBuyerQuantityTrade(
        constraints,
        45613,
        50,
        concessionContext,
        null,
        null,
        undefined,
        false,
      );
      expect(decision.move).toBe("NO_TRADE");
    });
  });

  // 5. Buyer does not repeat the same trade indefinitely — the caller-supplied
  // quantityTradeAlreadyUsed flag is the single source of truth and is
  // respected unconditionally, regardless of how favorable every other
  // input looks.
  it("respects quantityTradeAlreadyUsed even when every other condition is favorable", () => {
    const decision = decideBuyerQuantityTrade(constraints, 45613, 50, concessionContext, null, null, 54, true);
    expect(decision.move).toBe("NO_TRADE");
    expect(decision.reason).toContain("already used");
  });
});

// ---------------------------------------------------------------------
// Buyer Quantity-for-Price Redesign — the previous-buyer-price invariant.
//
// The single most important behavioral requirement: if the buyer has a
// real prior visible offer on record, a firing trade's price must never
// exceed it. Real fixtures below, not hand-invented — "A" is the EXACT
// live-calibration case that motivated the redesign (a real round-2
// MONITOR-24-FHD decision point where the OLD formula produced 8265 ->
// 8517, a price INCREASE); the new formula correctly refuses to fire
// rather than repeat that mistake.
// ---------------------------------------------------------------------
describe("decideBuyerQuantityTrade — previous-buyer-price invariant (redesign)", () => {
  const monitorConstraints: BuyerConstraints = {
    sku: "MONITOR-24-FHD",
    quantity: 20,
    maxUnitPrice: 8700,
    deliveryDeadlineDays: 7,
    urgency: "high",
  };

  // A. The flagship regression case: the exact real inputs that used to
  // produce a price INCREASE now correctly return NO_TRADE rather than
  // fire at a worse price than the buyer's own last offer.
  it("A: the original bug's exact real inputs (round-2 MONITOR, prior ask 8265) no longer fire a price increase", () => {
    const decision = decideBuyerQuantityTrade(
      monitorConstraints,
      8883, // the real round-1 merchant offer
      20,
      { round: 2, maxRounds: 6 },
      null,
      8265, // the real round-1 buyer price — the OLD formula produced 8517 here
      54,
      false,
    );
    // Never a price above 8265, whichever way this resolves.
    if (decision.move === "QUANTITY_FOR_PRICE") {
      expect(decision.unitPrice!).toBeLessThanOrEqual(8265);
    } else {
      expect(decision.move).toBe("NO_TRADE");
    }
  });

  it("never proposes a price above previousBuyerUnitPrice across a leverage sweep, on a fixture where the old formula would have increased it", () => {
    for (const leverage of [10, 40, 60, 90, 100]) {
      const decision = decideBuyerQuantityTrade(
        monitorConstraints,
        8883,
        20,
        { round: 2, maxRounds: 6 },
        null,
        8265,
        leverage,
        false,
      );
      if (decision.move === "QUANTITY_FOR_PRICE") {
        expect(decision.unitPrice!).toBeLessThanOrEqual(8265);
      }
    }
  });

  // B. Target boundary — when the buyer's previous offer is already at
  // (or effectively at) its own target, there is no room to construct a
  // genuinely better price, so the trade correctly does not fire.
  it("B: NO_TRADE when previousBuyerUnitPrice already equals the buyer's own target", () => {
    // resolveBuyerTarget(constraints) = round(45500 * 0.95) = 43225
    const decision = decideBuyerQuantityTrade(constraints, 45613, 50, concessionContext, null, 43225, 54, false);
    expect(decision.move).toBe("NO_TRADE");
    expect(decision.reason).toContain("not a meaningful improvement");
  });

  it("still fires (a real, useful trade) when no previous buyer price exists yet", () => {
    const decision = decideBuyerQuantityTrade(constraints, 45613, 50, concessionContext, null, null, 54, false);
    expect(decision.move).toBe("QUANTITY_FOR_PRICE");
  });
});

// ---------------------------------------------------------------------
// Buyer Quantity-for-Price Redesign — quantity sizing is no longer a
// universal 2x multiplier: it is continuous in the item's per-unit price
// (ticket size) and in the base quantity itself. Every value below comes
// from actually running resolveQuantityTradeIncreaseFraction /
// decideBuyerQuantityTrade, never hand-derived.
// ---------------------------------------------------------------------
describe("decideBuyerQuantityTrade — product-aware, magnitude-aware quantity sizing (redesign)", () => {
  // C/E. Ticket-size sensitivity: an expensive item (LAPTOP) gets a much
  // smaller relative increase than a cheap one (KEYBOARD), at comparable
  // base quantities — never the same universal multiplier.
  it("C/E: an expensive item's proposed increase is far more conservative than a cheap item's, at a similar base quantity", () => {
    const laptop = decideBuyerQuantityTrade(
      { sku: "LAPTOP-14-I5", quantity: 7, maxUnitPrice: 46200, deliveryDeadlineDays: 5, urgency: "medium" },
      47000,
      7,
      { round: 2, maxRounds: 8 },
      null,
      null,
      50,
      false,
    );
    const keyboard = decideBuyerQuantityTrade(
      { sku: "KEYBOARD-WIRELESS", quantity: 10, maxUnitPrice: 1300, deliveryDeadlineDays: 4, urgency: "medium" },
      1350,
      10,
      { round: 2, maxRounds: 8 },
      null,
      null,
      50,
      false,
    );
    expect(laptop.move).toBe("QUANTITY_FOR_PRICE");
    expect(keyboard.move).toBe("QUANTITY_FOR_PRICE");
    // Verified live: LAPTOP 7 -> 8 (+14%), KEYBOARD 10 -> 18 (+80%).
    expect(laptop.quantity).toBe(8);
    expect(keyboard.quantity).toBe(18);
    const laptopFraction = (laptop.quantity! - 7) / 7;
    const keyboardFraction = (keyboard.quantity! - 10) / 10;
    expect(keyboardFraction).toBeGreaterThan(laptopFraction);
  });

  it("C: MONITOR (mid-price) lands between LAPTOP and KEYBOARD's relative increase", () => {
    const decision = decideBuyerQuantityTrade(
      { sku: "MONITOR-24-FHD", quantity: 20, maxUnitPrice: 8700, deliveryDeadlineDays: 7, urgency: "medium" },
      8900,
      20,
      { round: 2, maxRounds: 8 },
      null,
      null,
      50,
      false,
    );
    expect(decision.move).toBe("QUANTITY_FOR_PRICE");
    expect(decision.quantity).toBe(27); // verified live: 20 -> 27 (+35%)
  });

  // D. Magnitude sensitivity: the SAME cheap product at a much larger
  // base quantity gets a smaller RELATIVE increase — large orders don't
  // blindly double either.
  it("D: the same product's relative increase shrinks as the base quantity grows large", () => {
    const small = decideBuyerQuantityTrade(
      { sku: "KEYBOARD-WIRELESS", quantity: 10, maxUnitPrice: 1300, deliveryDeadlineDays: 4, urgency: "medium" },
      1350,
      10,
      { round: 2, maxRounds: 8 },
      null,
      null,
      50,
      false,
    );
    const large = decideBuyerQuantityTrade(
      { sku: "KEYBOARD-WIRELESS", quantity: 150, maxUnitPrice: 1250, deliveryDeadlineDays: 5, urgency: "medium" },
      1300,
      150,
      { round: 2, maxRounds: 8 },
      null,
      null,
      50,
      false,
    );
    expect(small.move).toBe("QUANTITY_FOR_PRICE");
    expect(large.move).toBe("QUANTITY_FOR_PRICE");
    // Verified live: 10 -> 18 (+80%), 150 -> 179 (+19%) — 300 never
    // blindly becomes 600.
    expect(small.quantity).toBe(18);
    expect(large.quantity).toBe(179);
    const smallFraction = (small.quantity! - 10) / 10;
    const largeFraction = (large.quantity! - 150) / 150;
    expect(largeFraction).toBeLessThan(smallFraction);
  });

  // 3. Buyer never exceeds legitimate quantity constraints — bounded,
  // never unbounded runaway growth.
  it("proposes a bounded, legitimate quantity — never more than double the original ask", () => {
    const decision = decideBuyerQuantityTrade(constraints, 45613, 50, concessionContext, null, null, 54, false);
    expect(decision.quantity!).toBeGreaterThan(constraints.quantity);
    expect(decision.quantity!).toBeLessThanOrEqual(constraints.quantity * 2); // QUANTITY_TRADE_MAX_INCREASE_FRACTION = 1.0
  });

  // 4. Buyer remains within maxUnitPrice.
  it("never proposes a price above the buyer's hard ceiling, even with an extreme merchant offer", () => {
    const decision = decideBuyerQuantityTrade(
      constraints,
      100000, // absurdly high merchant offer
      50,
      concessionContext,
      null,
      null,
      54,
      false,
    );
    if (decision.move === "QUANTITY_FOR_PRICE") {
      expect(decision.unitPrice!).toBeLessThanOrEqual(constraints.maxUnitPrice);
    }
  });
});

// ---------------------------------------------------------------------
// Buyer Quantity-for-Price Redesign — leverage is a continuous influence
// on quantity sizing (a real gap in the old flat-doubling formula, which
// leverage never touched at all).
// ---------------------------------------------------------------------
describe("decideBuyerQuantityTrade — leverage continuously sizes the quantity ask (redesign)", () => {
  const monitorConstraints: BuyerConstraints = {
    sku: "MONITOR-24-FHD",
    quantity: 20,
    maxUnitPrice: 8700,
    deliveryDeadlineDays: 7,
    urgency: "medium",
  };

  // F. Weak < neutral < strong leverage produces a meaningfully
  // different proposed quantity, at fixed product/quantity/urgency.
  it("F: weak leverage proposes less quantity than neutral, which proposes less than strong (real, meaningful spread)", () => {
    const weak = decideBuyerQuantityTrade(monitorConstraints, 8900, 20, { round: 2, maxRounds: 8 }, null, null, 15, false);
    const neutral = decideBuyerQuantityTrade(monitorConstraints, 8900, 20, { round: 2, maxRounds: 8 }, null, null, 50, false);
    const strong = decideBuyerQuantityTrade(monitorConstraints, 8900, 20, { round: 2, maxRounds: 8 }, null, null, 90, false);

    expect(weak.move).toBe("QUANTITY_FOR_PRICE");
    expect(neutral.move).toBe("QUANTITY_FOR_PRICE");
    expect(strong.move).toBe("QUANTITY_FOR_PRICE");
    // Verified live: 25 < 27 < 30 — never a mere 1-2 unit rounding
    // artifact, a real double-digit-percent spread.
    expect(weak.quantity).toBe(25);
    expect(neutral.quantity).toBe(27);
    expect(strong.quantity).toBe(30);
    expect(weak.quantity!).toBeLessThan(neutral.quantity!);
    expect(neutral.quantity!).toBeLessThan(strong.quantity!);
  });

  it("never gates ELIGIBILITY on leverage band — remains a continuous sizing input only (Milestone 6's own lesson, still honored)", () => {
    for (const leverage of [0, 25, 50, 75, 100]) {
      const decision = decideBuyerQuantityTrade(monitorConstraints, 8900, 20, { round: 2, maxRounds: 8 }, null, null, leverage, false);
      expect(decision.move).toBe("QUANTITY_FOR_PRICE");
    }
  });
});

// ---------------------------------------------------------------------
// Buyer Quantity-for-Price Redesign — direct resolver-level tests. These
// isolate the two new pure functions from the final target/ceiling
// clamps inside decideBuyerQuantityTrade, so leverage's and urgency's
// own effect on the PRICE side is visible without being obscured by a
// clamp — see the integration-level tests above for the quantity side,
// where clamping happens not to interfere.
// ---------------------------------------------------------------------
describe("resolveQuantityTradePriceImprovementFraction — leverage and urgency (redesign)", () => {
  // G. Low urgency permits a stronger price improvement than high
  // urgency, at fixed leverage — high urgency must not accidentally
  // reward the buyer with a better trade economics than a patient buyer.
  it("G: low urgency yields a larger price-improvement fraction than medium, which is larger than high", () => {
    const low = resolveQuantityTradePriceImprovementFraction(1.0, "low");
    const medium = resolveQuantityTradePriceImprovementFraction(1.0, "medium");
    const high = resolveQuantityTradePriceImprovementFraction(1.0, "high");
    // Verified live: 0.2025 > 0.15 > 0.09.
    expect(low).toBeCloseTo(0.2025, 6);
    expect(medium).toBeCloseTo(0.15, 6);
    expect(high).toBeCloseTo(0.09, 6);
    expect(low).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(high);
  });

  it("omitting urgency reproduces the exact 'medium' fraction", () => {
    expect(resolveQuantityTradePriceImprovementFraction(1.0, undefined)).toBe(
      resolveQuantityTradePriceImprovementFraction(1.0, "medium"),
    );
  });

  it("stronger leverage yields a larger price-improvement fraction than weaker leverage, at fixed urgency", () => {
    const weak = resolveQuantityTradePriceImprovementFraction(0.5, "medium");
    const strong = resolveQuantityTradePriceImprovementFraction(1.5, "medium");
    expect(strong).toBeGreaterThan(weak);
  });

  it("is always bounded to [MIN, MAX] regardless of extreme inputs", () => {
    expect(resolveQuantityTradePriceImprovementFraction(1.5, "low")).toBeLessThanOrEqual(0.3);
    expect(resolveQuantityTradePriceImprovementFraction(0.5, "high")).toBeGreaterThanOrEqual(0.05);
  });
});

describe("resolveQuantityTradeIncreaseFraction — ticket size and order magnitude (redesign)", () => {
  it("E: an expensive per-unit price yields a smaller fraction than a cheap one, at the same base quantity and leverage", () => {
    const expensive = resolveQuantityTradeIncreaseFraction(46000, 50, 1.0); // LAPTOP-scale
    const cheap = resolveQuantityTradeIncreaseFraction(1300, 50, 1.0); // KEYBOARD-scale
    expect(cheap).toBeGreaterThan(expensive);
  });

  it("D: a very large base quantity yields a smaller fraction than a small one, at the same price and leverage", () => {
    const small = resolveQuantityTradeIncreaseFraction(8700, 5, 1.0);
    const large = resolveQuantityTradeIncreaseFraction(8700, 300, 1.0);
    expect(large).toBeLessThan(small);
  });

  it("is always bounded to [MIN_INCREASE_FRACTION, MAX_INCREASE_FRACTION] regardless of extreme inputs", () => {
    expect(resolveQuantityTradeIncreaseFraction(1_000_000, 100_000, 0.5)).toBeGreaterThanOrEqual(0.15);
    expect(resolveQuantityTradeIncreaseFraction(1, 1, 1.5)).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------
// Buyer Quantity-for-Price Redesign — degenerate trades must not fire.
// ---------------------------------------------------------------------
describe("decideBuyerQuantityTrade — degenerate trades correctly fall back to NO_TRADE (redesign)", () => {
  // H. Quantity increase not meaningful (rounds to no real increase once
  // bounded to a commercially conservative size).
  it("H: NO_TRADE when the resolved quantity increase would round to no real increase", () => {
    const decision = decideBuyerQuantityTrade(
      { sku: "LAPTOP-14-I5", quantity: 2, maxUnitPrice: 46000, deliveryDeadlineDays: 5, urgency: "medium" },
      47000,
      2,
      { round: 2, maxRounds: 8 },
      null,
      null,
      0,
      false,
    );
    expect(decision.move).toBe("NO_TRADE");
    expect(decision.reason).toContain("No meaningful quantity increase");
    expect(decision.quantity).toBeNull();
    expect(decision.unitPrice).toBeNull();
  });

  // H. Price improvement below the meaningful-improvement floor (0.5%).
  it("H: NO_TRADE when the best constructible price is not a meaningful improvement (< 0.5%) over the buyer's last offer", () => {
    const decision = decideBuyerQuantityTrade(
      { sku: "MONITOR-24-FHD", quantity: 20, maxUnitPrice: 8700, deliveryDeadlineDays: 7, urgency: "high" },
      8900,
      20,
      { round: 2, maxRounds: 8 },
      null,
      8265, // == resolveBuyerTarget for this exact fixture — no room to improve
      54,
      false,
    );
    expect(decision.move).toBe("NO_TRADE");
    expect(decision.reason).toContain("not a meaningful improvement");
  });
});
