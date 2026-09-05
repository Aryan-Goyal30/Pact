import { describe, expect, it } from "vitest";
import { evaluateQuantitySufficiency } from "./buyerQuantitySufficiency";
import type { BuyerConstraints } from "./buyerRules";

function make(
  quantity: number,
  maxUnitPrice: number,
  urgency: "low" | "medium" | "high" = "medium",
  quantityShortfallTolerance?: number,
): BuyerConstraints {
  return { sku: "LAPTOP-14-I5", quantity, maxUnitPrice, deliveryDeadlineDays: 10, urgency, quantityShortfallTolerance };
}

// UNIT TESTS: pure decision function, controlled inputs. Values verified
// empirically (see the Milestone 6 design/calibration review), not
// hand-derived — the calibration constants live in negotiationStrategy.ts.
describe("evaluateQuantitySufficiency", () => {
  it("no shortfall at all is always sufficient", () => {
    const decision = evaluateQuantitySufficiency(make(50, 45000), 50, 44000);
    expect(decision.verdict).toBe("SUFFICIENT");
    expect(decision.shortfallFraction).toBe(0);
  });

  it("offering MORE than requested is also sufficient", () => {
    const decision = evaluateQuantitySufficiency(make(50, 45000), 60, 44000);
    expect(decision.verdict).toBe("SUFFICIENT");
    expect(decision.shortfallFraction).toBe(0);
  });

  // The milestone's headline test: 150 requested / 100 offered.
  describe("150 requested / 100 offered (33% shortfall)", () => {
    it("a merely-acceptable price does NOT blindly justify accepting the shortfall", () => {
      const decision = evaluateQuantitySufficiency(make(150, 47000, "medium"), 100, 46900);
      expect(decision.verdict).toBe("INSUFFICIENT");
    });

    it("a substantially better price MAY justify accepting the shortfall", () => {
      const decision = evaluateQuantitySufficiency(make(150, 47000, "medium"), 100, 44900);
      expect(decision.verdict).toBe("INSUFFICIENT_PRICE_COMPENSATES");
    });

    it("the exact real browser Scenario 2 shape (150/100 @ 46125, medium urgency) is correctly judged insufficient", () => {
      // This is precisely the input that used to auto-accept in the
      // browser before Milestone 6 — see the browser-failure review.
      const decision = evaluateQuantitySufficiency(make(150, 47000, "medium"), 100, 46125);
      expect(decision.verdict).toBe("INSUFFICIENT");
    });
  });

  it("a small shortfall is much easier to accept than a large one, regardless of urgency", () => {
    const smallShortfall = evaluateQuantitySufficiency(make(150, 47000, "medium"), 145, 46950); // 3% shortfall, poor price
    const largeShortfall = evaluateQuantitySufficiency(make(150, 47000, "medium"), 100, 46950); // 33% shortfall, same poor price

    expect(smallShortfall.verdict).toBe("SUFFICIENT");
    expect(largeShortfall.verdict).toBe("INSUFFICIENT");
  });

  it("a severe shortfall is much harder to accept than a moderate one, even at a far better price", () => {
    const moderate = evaluateQuantitySufficiency(make(150, 47000, "medium"), 100, 44900); // 33% shortfall, good price
    const severe = evaluateQuantitySufficiency(make(150, 47000, "medium"), 30, 43000); // 80% shortfall, even better price

    expect(moderate.verdict).toBe("INSUFFICIENT_PRICE_COMPENSATES");
    // No price improvement rescues the severe case — this is the
    // "much harder" requirement: severity isn't just "same rule, bigger
    // number," the bar itself rises faster than any price can climb.
    expect(severe.verdict).toBe("INSUFFICIENT");
  });

  it("urgency shifts tolerance: the identical 33% shortfall at the identical price is judged differently", () => {
    const lowUrgency = evaluateQuantitySufficiency(make(150, 47000, "low"), 100, 45500);
    const highUrgency = evaluateQuantitySufficiency(make(150, 47000, "high"), 100, 45500);

    expect(lowUrgency.verdict).toBe("INSUFFICIENT"); // patient buyer, wants the full amount
    expect(highUrgency.verdict).toBe("SUFFICIENT"); // time-pressured, takes what's available
  });

  it("an explicit quantityShortfallTolerance override takes precedence over the urgency-derived default", () => {
    // Low urgency would ordinarily be strict (10% default tolerance),
    // but an explicit 40% override should widen it.
    const decision = evaluateQuantitySufficiency(make(150, 47000, "low", 0.4), 100, 46900);
    expect(decision.verdict).toBe("SUFFICIENT"); // 33% shortfall is within the explicit 40% override
  });

  it("every verdict carries an explicit, non-generic reason naming the real factors", () => {
    const decision = evaluateQuantitySufficiency(make(150, 47000, "medium"), 100, 46900);
    expect(decision.reason).not.toMatch(/^100 <= 150$/);
    expect(decision.reason.toLowerCase()).toContain("shortfall");
  });
});
