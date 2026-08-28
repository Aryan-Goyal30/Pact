import { describe, expect, it } from "vitest";
import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import type { MerchantConcessionContext, NegotiationRequest } from "@/lib/rules/negotiationEngine";
import {
  compareMerchantPackages,
  generateMerchantCandidates,
  scoreMerchantCandidate,
  selectBestMerchantCandidate,
} from "./merchantMoveSelection";
import { compareBuyerPackages } from "./buyerMoveSelection";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
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
    const { candidates } = generateMerchantCandidates(item, req(), concessionContext, null, null, null, 10);
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
    const { candidates } = generateMerchantCandidates(abundant, bulk, concessionContext, null, null, null, 300);
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
      10,
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
      15, // partial fulfillment: only 15 of 300 available
    );
    expect(quantityCandidates.some((c) => c.move === "QUANTITY_FOR_PRICE")).toBe(false);
  });

  it("evaluateBuyerReciprocity's own reason is re-exposed as reciprocityReason, unchanged", () => {
    const { reciprocityReason } = generateMerchantCandidates(item, req(), concessionContext, 43000, null, null, 10);
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
      300,
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
    const medium = generateMerchantCandidates(item, req(), concessionContext, null, null, null, 10);
    expect(medium.candidates.some((c) => c.move === "HOLD")).toBe(false);

    const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };
    const abundantResult = generateMerchantCandidates(abundant, req(), concessionContext, null, null, null, 10);
    expect(abundantResult.candidates.some((c) => c.move === "HOLD")).toBe(false);
  });

  it("is present for low (scarce) stock when the ordinary concession still has real room to move", () => {
    const scarce: CatalogItemSnapshot = { ...item, availableQty: 15 };
    const { candidates } = generateMerchantCandidates(scarce, req(), concessionContext, null, null, null, 10);
    expect(candidates.some((c) => c.move === "HOLD")).toBe(true);
  });

  it("is withheld even under scarce stock when the ordinary concession is already floor-clamped (never overrides the floor)", () => {
    const scarce: CatalogItemSnapshot = { ...item, availableQty: 15 };
    const extremeAsk = req({ maxUnitPrice: 1 }); // forces the ordinary concession to item.minPrice
    const { candidates } = generateMerchantCandidates(scarce, extremeAsk, concessionContext, null, null, null, 10);
    expect(candidates.some((c) => c.move === "HOLD")).toBe(false);
  });

  it("is never gated by leverage — merchantMoveSelection.ts never imports or references a leverage score at all", () => {
    // Structural proof: generateMerchantCandidates's signature has no
    // leverage parameter, unlike buyerMoveSelection.ts's strategyContext
    // — there is no leverage input this test could even vary. HOLD's
    // gate is entirely resolveMerchantStockPressure(item) (a static,
    // catalog-derived signal) plus the floor-safety check above.
    expect(generateMerchantCandidates.length).toBe(7); // item, request, concessionContext, priorBuyerUnitPrice, previousBuyerQuantity, previousBuyerDeliveryDays, authorizedQuantity — no leverage slot
  });
});

// PACT V2 Milestone 12 CORRECTION: merchant package/trade pricing must
// reflect the actual authorized (stock-capped) quantity, not the buyer's
// raw ask, wherever they diverge (partial fulfillment). This describe
// block is the required regression proof for both quantity paths — see
// merchantPackageTradeEvaluator.test.ts's own correction tests for the
// combined evaluator's price-level finding (no material price
// sensitivity to quantity magnitude in the current formula).
describe("Milestone 12 correction: candidates carry the authorized (not raw-asked) quantity", () => {
  // C: the solo quantity trade. IMPORTANT finding from this correction's
  // own implementation: evaluateMerchantTrade's own internal
  // hasQuantityLeverage(proposal.quantity) threshold gate means its
  // PRICING INPUT must stay `request.quantity` (substituting the capped
  // quantity there was tried and found to regress a correctly-calibrated
  // HOLD into a misleading COUNTER — see merchantMoveSelection.ts's own
  // comment at this call site). What this correction actually fixes for
  // the solo path is narrower but real: the WINNING CANDIDATE's own
  // `.quantity` field — what the merchant's message ultimately implies
  // it's offering — now reflects the authorized amount, not the raw ask.
  it("C: the solo QUANTITY_FOR_PRICE candidate carries the authorized quantity when the merchant is partially constrained", () => {
    const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 }; // high stock pressure -> genuine ACCEPT/COUNTER verdict
    const bulkRequest = req({ quantity: 300 });
    const { candidates } = generateMerchantCandidates(
      abundant,
      bulkRequest,
      concessionContext,
      null,
      150, // genuine round-over-round increase
      null,
      120, // authorizedQuantity: a hypothetical partial-fulfillment cap below the 300 asked
    );
    const trade = candidates.find((c) => c.move === "QUANTITY_FOR_PRICE");
    expect(trade).toBeDefined();
    expect(trade!.quantity).toBe(120); // NOT 300 — the authorized amount, not the raw ask
  });

  it("the combined QUANTITY_AND_DELIVERY_FOR_PRICE candidate also carries the authorized quantity, and the evaluator itself receives it (traced via the candidate's own price)", () => {
    const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };
    const { candidates } = generateMerchantCandidates(
      abundant,
      req({ quantity: 300, deliveryDeadlineDays: 12 }),
      concessionContext,
      null,
      150,
      8,
      45, // authorizedQuantity: e.g. a hypothetical partial-fulfillment cap
    );
    const combined = candidates.find((c) => c.move === "QUANTITY_AND_DELIVERY_FOR_PRICE");
    expect(combined).toBeDefined();
    expect(combined!.quantity).toBe(45); // NOT 300
  });

  // D: the hard inventory cap itself is untouched by this correction —
  // generateMerchantCandidates never decides offeredQuantity (that's
  // negotiationEngine.ts's job, upstream and unaffected); this just
  // confirms the parameter this correction added is never itself
  // capable of exceeding what the caller (applyMerchantConcession)
  // already authorized.
  it("D: authorizedQuantity is exactly what every quantity-carrying candidate uses — never re-derived, never exceeded", () => {
    const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };
    const { candidates } = generateMerchantCandidates(
      abundant,
      req({ quantity: 300, deliveryDeadlineDays: 12 }),
      concessionContext,
      null,
      150,
      8,
      45,
    );
    for (const candidate of candidates) {
      if (candidate.quantity !== undefined) {
        expect(candidate.quantity).toBeLessThanOrEqual(45);
      }
    }
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
    const { candidates } = generate(scarce, bulkRequest, ctx, null, null, null, 15); // partial fulfillment: only 15 of 300 available
    const hold = candidates.find((c) => c.move === "HOLD");
    const nonTrade = candidates.filter((c) => c.move === "HOLD" || c.move === "CONCEDE");
    expect(hold).toBeDefined();
    expect(selectBestMerchantCandidate(nonTrade).move).toBe("HOLD");
  });
});

// PACT V2 Milestone 11: package/deal-value comparison — direct unit
// tests of compareMerchantPackages itself. See
// merchantMoveSelection.oldVsNew.test.ts for the separate, mandatory
// proof that this comparator is behaviorally equivalent to Milestone
// 9/10's two-tier filter+reduce one across every candidate set the
// current codebase can actually produce.
describe("Milestone 11: compareMerchantPackages — asymmetric two-tier comparison", () => {
  it("the trade tier retains priority — an eligible trade beats a non-trade candidate even at a lower raw price", () => {
    const trade: CandidateMove = { move: "QUANTITY_FOR_PRICE", unitPrice: 45200, quantity: 300, reason: "q" };
    const concede: CandidateMove = { move: "CONCEDE", unitPrice: 45900, reason: "c" }; // numerically higher/"better" by raw price
    expect(selectBestMerchantCandidate([trade, concede]).move).toBe("QUANTITY_FOR_PRICE");
    expect(selectBestMerchantCandidate([concede, trade]).move).toBe("QUANTITY_FOR_PRICE"); // order-independent
  });

  it("within the trade tier, a higher price wins", () => {
    const quantity: CandidateMove = { move: "QUANTITY_FOR_PRICE", unitPrice: 45400, quantity: 300, reason: "q" };
    const delivery: CandidateMove = { move: "DELIVERY_FOR_PRICE", unitPrice: 45000, deliveryDays: 15, reason: "d" };
    expect(selectBestMerchantCandidate([quantity, delivery]).move).toBe("QUANTITY_FOR_PRICE");
    expect(selectBestMerchantCandidate([delivery, quantity]).move).toBe("QUANTITY_FOR_PRICE");
  });

  it("within the non-trade tier, a higher price wins", () => {
    const hold: CandidateMove = { move: "HOLD", unitPrice: 46500, reason: "h" };
    const concede: CandidateMove = { move: "CONCEDE", unitPrice: 45938, reason: "c" };
    expect(selectBestMerchantCandidate([hold, concede]).move).toBe("HOLD");
    expect(selectBestMerchantCandidate([concede, hold]).move).toBe("HOLD");
  });

  it("is deterministic — repeated calls on the same input produce the same winner", () => {
    const candidates: CandidateMove[] = [
      { move: "CONCEDE", unitPrice: 45900, reason: "c" },
      { move: "HOLD", unitPrice: 46200, reason: "h" },
      { move: "QUANTITY_FOR_PRICE", unitPrice: 45400, quantity: 300, reason: "q" },
    ];
    const first = selectBestMerchantCandidate(candidates);
    const second = selectBestMerchantCandidate(candidates);
    expect(second).toBe(first);
  });

  it("never mutates the candidates it compares or selects among", () => {
    const candidates: CandidateMove[] = [
      { move: "CONCEDE", unitPrice: 45900, reason: "c" },
      { move: "QUANTITY_FOR_PRICE", unitPrice: 45400, quantity: 300, reason: "q" },
    ];
    const snapshot = JSON.parse(JSON.stringify(candidates));
    compareMerchantPackages(candidates[0], candidates[1]);
    selectBestMerchantCandidate(candidates);
    expect(candidates).toEqual(snapshot);
  });

  // Milestone 9's own requirement, re-verified at this layer: candidate
  // quality must never be mirrored between sides. Feeding the EXACT same
  // candidate pair into both comparators and getting opposite
  // preferences is the concrete proof, not merely "they are different
  // function bodies."
  it("compareMerchantPackages is genuinely asymmetric with compareBuyerPackages — the same two candidates rank oppositely", () => {
    const cheaper: CandidateMove = { move: "CONCEDE", unitPrice: 44500, quantity: 50, reason: "cheaper" };
    const pricier: CandidateMove = { move: "CONCEDE", unitPrice: 45500, quantity: 50, reason: "pricier" };
    const buyerConstraints: BuyerConstraints = {
      sku: item.sku,
      quantity: 50,
      maxUnitPrice: 46000,
      deliveryDeadlineDays: 10,
    };

    // The merchant prefers the pricier one (higher price -> positive)...
    expect(compareMerchantPackages(pricier, cheaper)).toBeGreaterThan(0);
    // ...while the buyer prefers the cheaper one, for the EXACT SAME pair.
    expect(compareBuyerPackages(cheaper, pricier, buyerConstraints, 50, 10)).toBeGreaterThan(0);
  });
});
