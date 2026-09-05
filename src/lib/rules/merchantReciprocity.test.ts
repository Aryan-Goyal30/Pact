import { describe, expect, it } from "vitest";
import { evaluateBuyerReciprocity } from "./merchantReciprocity";

describe("evaluateBuyerReciprocity", () => {
  it("CONCEDED: buyer's ask moved up (toward the merchant) rewards with a multiplier above 1", () => {
    const result = evaluateBuyerReciprocity(43000, 42000);
    expect(result.behavior).toBe("CONCEDED");
    expect(result.speedMultiplier).toBeGreaterThan(1);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("HELD: an unchanged buyer ask produces a multiplier below 1", () => {
    const result = evaluateBuyerReciprocity(42000, 42000);
    expect(result.behavior).toBe("HELD");
    expect(result.speedMultiplier).toBeLessThan(1);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("WITHDREW: a buyer ask moving down produces the most conservative multiplier", () => {
    const result = evaluateBuyerReciprocity(41000, 42000);
    expect(result.behavior).toBe("WITHDREW");
    expect(result.speedMultiplier).toBeLessThan(1);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("WITHDREW is treated more conservatively than HELD", () => {
    const held = evaluateBuyerReciprocity(42000, 42000);
    const withdrew = evaluateBuyerReciprocity(41000, 42000);
    expect(withdrew.speedMultiplier).toBeLessThan(held.speedMultiplier);
  });

  it("UNKNOWN: no prior ask is a complete no-op (multiplier of exactly 1)", () => {
    expect(evaluateBuyerReciprocity(42000, null).behavior).toBe("UNKNOWN");
    expect(evaluateBuyerReciprocity(42000, null).speedMultiplier).toBe(1);
    expect(evaluateBuyerReciprocity(42000, undefined).speedMultiplier).toBe(1);
  });

  it("bounds: every multiplier stays modest and positive, never a cliff to zero or an extreme spike", () => {
    const behaviors = [
      evaluateBuyerReciprocity(43000, 42000), // CONCEDED
      evaluateBuyerReciprocity(42000, 42000), // HELD
      evaluateBuyerReciprocity(41000, 42000), // WITHDREW
      evaluateBuyerReciprocity(42000, null), // UNKNOWN
    ];
    for (const b of behaviors) {
      expect(b.speedMultiplier).toBeGreaterThan(0.3);
      expect(b.speedMultiplier).toBeLessThan(1.5);
    }
  });

  it("ordering: CONCEDED > UNKNOWN > HELD > WITHDREW", () => {
    const conceded = evaluateBuyerReciprocity(43000, 42000).speedMultiplier;
    const unknown = evaluateBuyerReciprocity(42000, null).speedMultiplier;
    const held = evaluateBuyerReciprocity(42000, 42000).speedMultiplier;
    const withdrew = evaluateBuyerReciprocity(41000, 42000).speedMultiplier;
    expect(conceded).toBeGreaterThan(unknown);
    expect(unknown).toBeGreaterThan(held);
    expect(held).toBeGreaterThan(withdrew);
  });
});
