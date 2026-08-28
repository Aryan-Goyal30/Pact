import { describe, expect, it } from "vitest";
import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import type { MerchantConcessionContext, NegotiationRequest } from "@/lib/rules/negotiationEngine";
import {
  generateMerchantCandidates,
  scoreMerchantCandidate,
  selectBestMerchantCandidate,
} from "./merchantMoveSelection";
import type { CandidateMove } from "./candidateMove";

const item: CatalogItemSnapshot = {
  sku: "LAPTOP-14-I5",
  listedPrice: 48000,
  minPrice: 44000,
  availableQty: 100, // "medium" stock pressure -> HOLD's own gate stays closed by default
  standardDeliveryDays: 5,
  maxDeliveryDays: 20,
  negotiationEnabled: true,
};

function req(overrides: Partial<NegotiationRequest & { maxUnitPrice: number }> = {}): NegotiationRequest & {
  maxUnitPrice: number;
} {
  return {
    sku: item.sku,
    quantity: 10,
    maxUnitPrice: 44500,
    deliveryDeadlineDays: 10,
    deliveryFlexible: true,
    ...overrides,
  };
}

const concessionContext: MerchantConcessionContext = { round: 2, maxRounds: 6, previousOfferUnitPrice: 46500 };

describe("generateMerchantCandidates — adapters map existing decisions correctly", () => {
  it("the ordinary concession (computeMerchantConcessionPrice) always adapts into a CONCEDE candidate", () => {
    const { candidates } = generateMerchantCandidates(item, req(), concessionContext, null, null, null);
    const ordinary = candidates.find((c) => c.move === "CONCEDE");
    expect(ordinary).toBeDefined();
    expect(ordinary!.unitPrice).toBeGreaterThan(item.minPrice);
    expect(ordinary!.unitPrice).toBeLessThan(item.listedPrice);
    expect(ordinary!.quantity).toBeUndefined();
    expect(ordinary!.deliveryDays).toBeUndefined();
  });

  it("an ACCEPT/COUNTER quantity trade verdict (evaluateMerchantTrade) adapts into a QUANTITY_FOR_PRICE candidate carrying the requested quantity", () => {
    const bulk = req({ quantity: 300 }); // LARGE_ORDER_QUANTITY_THRESHOLD
    const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };
    const { candidates } = generateMerchantCandidates(abundant, bulk, concessionContext, null, null, null);
    const trade = candidates.find((c) => c.move === "QUANTITY_FOR_PRICE");
    expect(trade).toBeDefined();
    expect(trade!.quantity).toBe(300);
    expect(trade!.deliveryDays).toBeUndefined();
    expect(trade!.reason.length).toBeGreaterThan(0);
  });

  it("an ACCEPT/COUNTER delivery trade verdict (evaluateMerchantDeliveryTrade) adapts into a DELIVERY_FOR_PRICE candidate carrying the traded delivery date", () => {
    const constrained: CatalogItemSnapshot = { ...item, availableQty: 15 };
    const { candidates, deliveryDays } = generateMerchantCandidates(
      constrained,
      req({ deliveryDeadlineDays: 12 }),
      concessionContext,
      null,
      null,
      8, // genuine round-over-round extension (8 -> 12)
    );
    const trade = candidates.find((c) => c.move === "DELIVERY_FOR_PRICE");
    expect(trade).toBeDefined();
    expect(trade!.deliveryDays).toBe(deliveryDays);
    expect(trade!.quantity).toBeUndefined();
  });

  it("a HOLD/REJECT verdict from either evaluator never produces its own distinct trade candidate", () => {
    const scarce: CatalogItemSnapshot = { ...item, availableQty: 15 };
    // Quantity: scarce stock -> evaluateMerchantTrade's own HOLD verdict ("does not currently justify").
    const { candidates: quantityCandidates } = generateMerchantCandidates(
      scarce,
      req({ quantity: 300 }),
      concessionContext,
      null,
      null,
      null,
    );
    expect(quantityCandidates.some((c) => c.move === "QUANTITY_FOR_PRICE")).toBe(false);
  });

  it("evaluateBuyerReciprocity's own reason is re-exposed as reciprocityReason, unchanged", () => {
    const { reciprocityReason } = generateMerchantCandidates(item, req(), concessionContext, 43000, null, null);
    expect(reciprocityReason.length).toBeGreaterThan(0);
  });
});

describe("generateMerchantCandidates — all eligible candidates generated (no short-circuiting)", () => {
  it("quantity and delivery trades are evaluated independently — both can appear together", () => {
    const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };
    const { candidates } = generateMerchantCandidates(
      abundant,
      req({ quantity: 300, deliveryDeadlineDays: 12 }),
      concessionContext,
      null,
      150, // genuine quantity increase
      8, // genuine delivery increase, simultaneously
    );
    expect(candidates.some((c) => c.move === "QUANTITY_FOR_PRICE")).toBe(true);
    // Abundant stock withholds the delivery discount (ABUNDANT_STOCK_DELIVERY_TRADE_MULTIPLIER = 0,
    // a HOLD verdict) — so only quantity appears as a distinct candidate here; still proves
    // independent evaluation (see the E-scenario for a case where delivery instead wins).
    const moves = candidates.map((c) => c.move);
    expect(moves).toContain("CONCEDE");
    expect(moves).toContain("QUANTITY_FOR_PRICE");
  });
});

describe("selectBestMerchantCandidate — order-independent comparison, asymmetric objective", () => {
  it("quantity trade can win over delivery trade purely because it is a higher price, regardless of array order", () => {
    const arr: CandidateMove[] = [
      { move: "DELIVERY_FOR_PRICE", unitPrice: 45000, deliveryDays: 15, reason: "d" },
      { move: "QUANTITY_FOR_PRICE", unitPrice: 45400, quantity: 300, reason: "q" }, // higher = better for the merchant
    ];
    expect(selectBestMerchantCandidate(arr).move).toBe("QUANTITY_FOR_PRICE");
    expect(selectBestMerchantCandidate([...arr].reverse()).move).toBe("QUANTITY_FOR_PRICE");
  });

  it("delivery trade can equally win over quantity trade when it is the higher price, regardless of array order", () => {
    const arr: CandidateMove[] = [
      { move: "QUANTITY_FOR_PRICE", unitPrice: 45000, quantity: 300, reason: "q" },
      { move: "DELIVERY_FOR_PRICE", unitPrice: 45400, deliveryDays: 15, reason: "d" },
    ];
    expect(selectBestMerchantCandidate(arr).move).toBe("DELIVERY_FOR_PRICE");
    expect(selectBestMerchantCandidate([...arr].reverse()).move).toBe("DELIVERY_FOR_PRICE");
  });

  it("a genuinely eligible trade always beats plain CONCEDE, even though the trade's own price is numerically LOWER (the buyer-side objective would get this backwards)", () => {
    // This is the core merchant/buyer asymmetry this milestone required:
    // a trade's whole premise is the merchant accepting a WORSE headline
    // price in exchange for non-price value (see the module's own doc
    // comment on selectBestMerchantCandidate) — so "prefer higher price"
    // alone would make CONCEDE always win. The two-tier selector fixes
    // this: an eligible trade (already vetted by its own evaluator) is
    // preferred unconditionally over the non-trade tier.
    const arr: CandidateMove[] = [
      { move: "CONCEDE", unitPrice: 45900, reason: "c" }, // numerically higher/"better" by raw price
      { move: "QUANTITY_FOR_PRICE", unitPrice: 45200, quantity: 300, reason: "q" }, // numerically lower, but a real vetted trade
    ];
    expect(selectBestMerchantCandidate(arr).move).toBe("QUANTITY_FOR_PRICE");
  });

  it("HOLD can be preferred over CONCEDE within the non-trade tier when it is genuinely the higher price", () => {
    const arr: CandidateMove[] = [
      { move: "CONCEDE", unitPrice: 45938, reason: "c" },
      { move: "HOLD", unitPrice: 46500, reason: "h" },
    ];
    expect(selectBestMerchantCandidate(arr).move).toBe("HOLD");
  });

  it("scoreMerchantCandidate is the exact opposite objective of the buyer's — higher is better, never mirrored", () => {
    const candidate: CandidateMove = { move: "CONCEDE", unitPrice: 45123, reason: "x" };
    expect(scoreMerchantCandidate(candidate)).toBe(45123); // same raw number as the buyer's score...
    // ...but selectBestMerchantCandidate picks the HIGHEST of it, provably the opposite of the buyer's selectBestBuyerCandidate (lowest).
    const higher: CandidateMove = { move: "CONCEDE", unitPrice: 45500, reason: "y" };
    expect(selectBestMerchantCandidate([candidate, higher]).unitPrice).toBe(45500);
  });
});

describe("merchant HOLD candidate — real, gated on stock scarcity (not leverage, not reciprocity)", () => {
  it("is absent for medium/abundant stock even with a real previousOfferUnitPrice", () => {
    const medium = generateMerchantCandidates(item, req(), concessionContext, null, null, null);
    expect(medium.candidates.some((c) => c.move === "HOLD")).toBe(false);

    const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };
    const abundantResult = generateMerchantCandidates(abundant, req(), concessionContext, null, null, null);
    expect(abundantResult.candidates.some((c) => c.move === "HOLD")).toBe(false);
  });

  it("is present for low (scarce) stock when the ordinary concession still has real room to move", () => {
    const scarce: CatalogItemSnapshot = { ...item, availableQty: 15 };
    const { candidates } = generateMerchantCandidates(scarce, req(), concessionContext, null, null, null);
    expect(candidates.some((c) => c.move === "HOLD")).toBe(true);
  });

  it("is withheld even under scarce stock when the ordinary concession is already floor-clamped (never overrides the floor)", () => {
    const scarce: CatalogItemSnapshot = { ...item, availableQty: 15 };
    const extremeAsk = req({ maxUnitPrice: 1 }); // forces the ordinary concession to item.minPrice
    const { candidates } = generateMerchantCandidates(scarce, extremeAsk, concessionContext, null, null, null);
    expect(candidates.some((c) => c.move === "HOLD")).toBe(false);
  });

  it("is never gated by leverage — merchantMoveSelection.ts never imports or references a leverage score at all", () => {
    // Structural proof: generateMerchantCandidates's signature has no
    // leverage parameter, unlike buyerMoveSelection.ts's strategyContext
    // — there is no leverage input this test could even vary. HOLD's
    // gate is entirely resolveMerchantStockPressure(item) (a static,
    // catalog-derived signal) plus the floor-safety check above.
    expect(generateMerchantCandidates.length).toBe(6); // item, request, concessionContext, priorBuyerUnitPrice, previousBuyerQuantity, previousBuyerDeliveryDays — no leverage slot
  });
});

describe("realistic: merchant HOLD wins by genuine comparison in a real runMerchantAgent scenario", () => {
  it("scarce stock lets HOLD beat a quantity trade's own HOLD-verdict concession on price (see merchantAgent.test.ts's full assertion of this fixture)", async () => {
    // Numbers reused verbatim from merchantAgent.test.ts's "conditional
    // quantity <-> price trade" describe block — not re-derived here.
    const { generateMerchantCandidates: generate } = await import("./merchantMoveSelection");
    const scarce: CatalogItemSnapshot = { ...item, availableQty: 15, maxDeliveryDays: 12 };
    const bulkRequest = req({ quantity: 300, maxUnitPrice: 44100, deliveryFlexible: undefined });
    const ctx: MerchantConcessionContext = { round: 2, maxRounds: 6, previousOfferUnitPrice: 45600 };
    const { candidates } = generate(scarce, bulkRequest, ctx, null, null, null);
    const hold = candidates.find((c) => c.move === "HOLD");
    const nonTrade = candidates.filter((c) => c.move === "HOLD" || c.move === "CONCEDE");
    expect(hold).toBeDefined();
    expect(selectBestMerchantCandidate(nonTrade).move).toBe("HOLD");
  });
});
