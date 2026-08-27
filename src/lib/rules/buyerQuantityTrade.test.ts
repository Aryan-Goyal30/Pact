import { describe, expect, it } from "vitest";
import { decideBuyerQuantityTrade } from "./buyerQuantityTrade";
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
  it("proposes QUANTITY_FOR_PRICE at moderate leverage with a real price gap and rounds to spare", () => {
    const decision = decideBuyerQuantityTrade(
      constraints,
      45613, // merchant's current offer — above the buyer's target (43225)
      50, // merchant fully supplied the original request
      concessionContext,
      null,
      54, // moderate leverage — between CONCEDE_LEVERAGE_THRESHOLD (40) and HOLD_LEVERAGE_THRESHOLD (60)
      false,
    );
    expect(decision.move).toBe("QUANTITY_FOR_PRICE");
    // Verified empirically against the real orchestrator's own golden
    // trajectory (see orchestrator.test.ts) — not hand-derived.
    expect(decision.quantity).toBe(100);
    expect(decision.unitPrice).toBe(43963);
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
        54,
        false,
      );
      expect(decision.move).toBe("NO_TRADE");
    });

    it("the chip has already been used earlier in this negotiation", () => {
      const decision = decideBuyerQuantityTrade(constraints, 45613, 50, concessionContext, null, 54, true);
      expect(decision.move).toBe("NO_TRADE");
    });

    it("the merchant is already short-supplying the original request", () => {
      const decision = decideBuyerQuantityTrade(
        constraints,
        45613,
        30, // less than constraints.quantity (50) — already stock-constrained
        concessionContext,
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
        undefined,
        false,
      );
      expect(decision.move).toBe("NO_TRADE");
    });
  });

  // PACT V2 Milestone 6: leverage is a continuous ASK-SIZE modulator, not
  // a binary eligibility gate — real browser testing showed the old
  // leverage-band gate incorrectly blocked a genuinely strong-leverage
  // buyer from a real opportunity. Values verified empirically, not
  // hand-derived.
  describe("leverage modulates the size of the ask, never eligibility (Milestone 6)", () => {
    it("a high-leverage buyer CAN still consider QUANTITY_FOR_PRICE, and asks for a bigger discount", () => {
      const decision = decideBuyerQuantityTrade(constraints, 45613, 50, concessionContext, null, 90, false);
      expect(decision.move).toBe("QUANTITY_FOR_PRICE");
      expect(decision.quantity).toBe(100);
      expect(decision.unitPrice).toBe(43640);
    });

    it("a low-leverage buyer ALSO considers it, but with a more modest ask than a high-leverage buyer", () => {
      const weak = decideBuyerQuantityTrade(constraints, 45613, 50, concessionContext, null, 20, false);
      const strong = decideBuyerQuantityTrade(constraints, 45613, 50, concessionContext, null, 90, false);

      expect(weak.move).toBe("QUANTITY_FOR_PRICE");
      expect(weak.unitPrice).toBe(44268);
      // Weak leverage asks for less of a discount than strong leverage —
      // a real, continuous difference, not a binary in/out.
      expect(weak.unitPrice!).toBeGreaterThan(strong.unitPrice!);
    });

    it("the ask size scales monotonically with leverage across the full range", () => {
      const low = decideBuyerQuantityTrade(constraints, 45613, 50, concessionContext, null, 10, false);
      const mid = decideBuyerQuantityTrade(constraints, 45613, 50, concessionContext, null, 54, false);
      const high = decideBuyerQuantityTrade(constraints, 45613, 50, concessionContext, null, 95, false);

      expect(low.move).toBe("QUANTITY_FOR_PRICE");
      expect(mid.move).toBe("QUANTITY_FOR_PRICE");
      expect(high.move).toBe("QUANTITY_FOR_PRICE");
      // Higher leverage -> lower (more aggressive) price ask.
      expect(low.unitPrice!).toBeGreaterThan(mid.unitPrice!);
      expect(mid.unitPrice!).toBeGreaterThan(high.unitPrice!);
    });
  });

  // 3. Buyer never exceeds legitimate quantity constraints (a sane,
  // bounded, positive proposal — not an arbitrary or runaway number).
  it("proposes a bounded, legitimate quantity — a fixed multiple of the original ask, not an arbitrary number", () => {
    const decision = decideBuyerQuantityTrade(
      constraints,
      45613,
      50,
      concessionContext,
      null,
      54,
      false,
    );
    expect(decision.quantity).toBe(100); // exactly double the original 50, per QUANTITY_TRADE_INCREASE_FRACTION
    expect(decision.quantity!).toBeGreaterThan(constraints.quantity);
    expect(decision.quantity!).toBeLessThan(constraints.quantity * 3); // bounded, not unbounded growth
  });

  // 4. Buyer remains within maxUnitPrice.
  it("never proposes a price above the buyer's hard ceiling, even with an extreme merchant offer", () => {
    const decision = decideBuyerQuantityTrade(
      constraints,
      100000, // absurdly high merchant offer
      50,
      concessionContext,
      null,
      54,
      false,
    );
    if (decision.move === "QUANTITY_FOR_PRICE") {
      expect(decision.unitPrice!).toBeLessThanOrEqual(constraints.maxUnitPrice);
    }
  });

  // 5. Buyer does not repeat the same trade indefinitely — the caller-supplied
  // quantityTradeAlreadyUsed flag is the single source of truth and is
  // respected unconditionally, regardless of how favorable every other
  // input looks.
  it("respects quantityTradeAlreadyUsed even when every other condition is favorable", () => {
    const decision = decideBuyerQuantityTrade(constraints, 45613, 50, concessionContext, null, 54, true);
    expect(decision.move).toBe("NO_TRADE");
    expect(decision.reason).toContain("already used");
  });
});
