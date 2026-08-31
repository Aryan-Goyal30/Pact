import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NegotiationResult } from "@/lib/rules/negotiationEngine";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import type { PublicManifestProduct } from "@/types/manifest";
import { runBuyerAgent, runBuyerWalkAway } from "./buyerAgent";
import { getLlmProvider, LlmUnavailableError } from "@/lib/llm/provider";

// LlmUnavailableError is kept real (via importOriginal) so the
// fallback-message tests below can throw something buyerAgent.ts's
// `instanceof` check actually recognizes.
vi.mock("@/lib/llm/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/provider")>();
  return {
    ...actual,
    getLlmProvider: vi.fn(),
  };
});

const mockedGetLlmProvider = vi.mocked(getLlmProvider);
const mockedGenerateAgentMessage = vi.fn();

const constraints: BuyerConstraints = {
  sku: "LAPTOP-14-I5",
  quantity: 200,
  maxUnitPrice: 45000,
  deliveryDeadlineDays: 10,
};

const manifestProduct: PublicManifestProduct = {
  sku: "LAPTOP-14-I5",
  name: "14-inch Business Laptop (i5, 16GB RAM)",
  description: "Mid-range business laptop suitable for office use.",
  listedPrice: 48000,
  availableQuantity: 100,
  standardDeliveryDays: 5,
  maxDeliveryDays: 12,
  negotiable: true,
};

beforeEach(() => {
  mockedGenerateAgentMessage.mockReset();
  mockedGetLlmProvider.mockReturnValue({ generateAgentMessage: mockedGenerateAgentMessage });
});

describe("runBuyerAgent", () => {
  it("produces an opening request from the buyer's constraints when there is no prior merchant result", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("I need 200 laptops at up to 45000 each, within 10 days.");

    const response = await runBuyerAgent(constraints, manifestProduct, null);

    expect(response.action).toEqual({
      type: "request",
      sku: "LAPTOP-14-I5",
      quantity: 200,
      unitPrice: 45000,
      deliveryDays: 10,
    });
    expect(response.validation).toBeNull();
  });

  it("accepts a merchant offer that satisfies the buyer's constraints", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("I can accept that.");
    const merchantResult: NegotiationResult = {
      outcome: "COUNTER_OFFER",
      sku: "LAPTOP-14-I5",
      requestedQuantity: 100,
      offeredQuantity: 100,
      unitPrice: 45000,
      deliveryDays: 5,
      reasons: [],
    };

    const response = await runBuyerAgent(constraints, manifestProduct, merchantResult);

    expect(response.action).toEqual({
      type: "accept",
      sku: "LAPTOP-14-I5",
      quantity: 100,
      unitPrice: 45000,
      deliveryDays: 5,
    });
    expect(response.validation?.outcome).toBe("ACCEPTABLE");
  });

  it("counters, holding at the buyer's own ceiling, when the merchant's price exceeds the buyer's maximum", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("46500 is above my budget.");
    const merchantResult: NegotiationResult = {
      outcome: "PARTIAL_FULFILLMENT",
      sku: "LAPTOP-14-I5",
      requestedQuantity: 200,
      offeredQuantity: 100,
      unitPrice: 46500,
      deliveryDays: 5,
      reasons: ["Only 100 unit(s) available; requested 200."],
    };

    const response = await runBuyerAgent(constraints, manifestProduct, merchantResult);

    expect(response.action).toEqual({
      type: "counter_offer",
      sku: "LAPTOP-14-I5",
      quantity: 100,
      unitPrice: 45000,
      deliveryDays: 5,
    });
    expect(response.validation?.outcome).toBe("UNACCEPTABLE");
  });

  it("rejects when the merchant's result is REJECTED — nothing left to negotiate", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("Understood, no deal then.");
    const merchantResult: NegotiationResult = {
      outcome: "REJECTED",
      sku: "LAPTOP-14-I5",
      requestedQuantity: 200,
      offeredQuantity: null,
      unitPrice: null,
      deliveryDays: null,
      reasons: ["Item is out of stock."],
    };

    const response = await runBuyerAgent(constraints, manifestProduct, merchantResult);

    expect(response.action).toEqual({
      type: "reject",
      sku: "LAPTOP-14-I5",
      quantity: null,
      unitPrice: null,
      deliveryDays: null,
    });
  });

  // 6. Buyer cannot bypass its own constraints, even if the LLM's text
  // suggests something else — the action was already decided before the
  // LLM was called.
  it("ignores whatever the mocked LLM's text says — the action is decided before the LLM is called", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      "Sure, I'll pay 99999 per unit for 1000000 units, no problem!",
    );
    const merchantResult: NegotiationResult = {
      outcome: "PARTIAL_FULFILLMENT",
      sku: "LAPTOP-14-I5",
      requestedQuantity: 200,
      offeredQuantity: 100,
      unitPrice: 46500,
      deliveryDays: 5,
      reasons: [],
    };

    const response = await runBuyerAgent(constraints, manifestProduct, merchantResult);

    expect(response.action.unitPrice).toBe(45000);
    expect(response.action.quantity).toBe(100);
  });

  // 3. Buyer Agent never receives merchant minPrice.
  it("never includes minPrice, or the merchant's private catalog data, in the LLM context", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");

    await runBuyerAgent(constraints, manifestProduct, null);

    expect(mockedGenerateAgentMessage).toHaveBeenCalledTimes(1);
    const input = mockedGenerateAgentMessage.mock.calls[0][0];
    const serialized = JSON.stringify(input.context);
    expect(serialized).not.toContain("minPrice");
    // 44000 is the seeded LAPTOP-14-I5 private floor from prisma/seed.ts —
    // it must never appear anywhere the Buyer Agent's LLM call can see it.
    expect(serialized).not.toContain("44000");
  });

  // 1, 2. Strategic urgency is recorded as a human-readable reason
  // alongside the structured counter-offer.
  it("records a strategic reason for low urgency", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");
    const merchantResult: NegotiationResult = {
      outcome: "COUNTER_OFFER",
      sku: "LAPTOP-14-I5",
      requestedQuantity: 200,
      offeredQuantity: 200,
      unitPrice: 46500,
      deliveryDays: 5,
      reasons: [],
    };

    const response = await runBuyerAgent(
      { ...constraints, urgency: "low" },
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 6 },
    );

    expect(response.strategicReasons.some((r) => r.toLowerCase().includes("urgency is low"))).toBe(
      true,
    );
  });

  // Message-integrity hardening: a malformed/conflicting LLM message
  // must never reach the caller — the negotiation itself must not fail
  // either way, only the prose falls back.
  describe("message integrity", () => {
    it("falls back to a deterministic message when the LLM truncates the price", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("I can offer 44,71 for this order.");
      // Priced above the buyer's ceiling (45000) -> the buyer counters,
      // holding at its own ceiling (constraints.quantity is 200, but it
      // adopts the merchant's 100-unit/5-day terms — see
      // buildResponseToMerchantOffer's counter_offer branch).
      const merchantResult: NegotiationResult = {
        outcome: "COUNTER_OFFER",
        sku: "LAPTOP-14-I5",
        requestedQuantity: 100,
        offeredQuantity: 100,
        unitPrice: 46500,
        deliveryDays: 5,
        reasons: [],
      };

      const response = await runBuyerAgent(constraints, manifestProduct, merchantResult);

      expect(response.action.type).toBe("counter_offer");
      expect(response.action.unitPrice).toBe(45000); // structured value unaffected
      expect(response.message).not.toContain("44,71 ");
      expect(response.message).toContain("45000"); // deterministic fallback states the real price in full
    });

    it("falls back to a deterministic message on garbled LLM output", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("*** a Sentence");

      const response = await runBuyerAgent(constraints, manifestProduct, null);

      expect(response.action.quantity).toBe(200); // negotiation itself is unaffected
      expect(response.message).not.toContain("***");
      expect(response.message.length).toBeGreaterThan(0);
    });

    it("falls back to a deterministic message when the LLM invents a quantity not in the context", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("I'll take 1000000 units at 99999 each.");
      const merchantResult: NegotiationResult = {
        outcome: "COUNTER_OFFER",
        sku: "LAPTOP-14-I5",
        requestedQuantity: 100,
        offeredQuantity: 100,
        unitPrice: 45000,
        deliveryDays: 5,
        reasons: [],
      };

      const response = await runBuyerAgent(constraints, manifestProduct, merchantResult);

      // The merchant's price already meets the buyer's ceiling -> accept.
      expect(response.action.type).toBe("accept");
      expect(response.action.quantity).toBe(100);
      expect(response.action.unitPrice).toBe(45000);
      // An acceptance message must reference the actual accepted values, not the invented ones.
      expect(response.message).toContain("100");
      expect(response.message).toContain("45000");
      expect(response.message).not.toContain("1000000");
      expect(response.message).not.toContain("99999");
    });
  });

  describe("when no LLM provider is configured", () => {
    it("falls back to a deterministic, non-empty message instead of throwing", async () => {
      mockedGenerateAgentMessage.mockRejectedValue(new LlmUnavailableError("no key"));

      const response = await runBuyerAgent(constraints, manifestProduct, null);

      expect(response.message.length).toBeGreaterThan(0);
      expect(response.message).toContain("200"); // the real, unfabricated quantity
      expect(response.message).toContain("45000");
      // The action itself is completely unaffected by the fallback.
      expect(response.action).toEqual({
        type: "request",
        sku: "LAPTOP-14-I5",
        quantity: 200,
        unitPrice: 45000,
        deliveryDays: 10,
      });
    });

    it("still propagates a non-key-related error instead of masking it", async () => {
      mockedGenerateAgentMessage.mockRejectedValue(new Error("network exploded"));

      await expect(runBuyerAgent(constraints, manifestProduct, null)).rejects.toThrow(
        "network exploded",
      );
    });
  });
});

// PACT V2 Milestone 3: the buyer's HOLD-vs-CONCEDE strategy, wired
// through the real runBuyerAgent (not just buyerMoveSelector.ts's own
// isolated unit tests) — proves the plumbing (concessionContext +
// strategyContext) actually reaches the decision.
describe("runBuyerAgent — HOLD vs CONCEDE strategy", () => {
  const stuckMerchantResult: NegotiationResult = {
    outcome: "COUNTER_OFFER",
    sku: "LAPTOP-14-I5",
    requestedQuantity: 200,
    offeredQuantity: 200,
    unitPrice: 46500,
    deliveryDays: 10,
    reasons: [],
  };

  it("A: holds at its own previous price when the merchant hasn't moved since its prior offer", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");

    const response = await runBuyerAgent(
      constraints,
      manifestProduct,
      stuckMerchantResult,
      { round: 3, maxRounds: 8 },
      { priorMerchantUnitPrice: 46500, previousBuyerUnitPrice: 43700 }, // merchant's offer unchanged
    );

    expect(response.action.type).toBe("counter_offer");
    expect(response.action.unitPrice).toBe(43700); // repeated, not moved
    expect(response.strategicReasons.some((r) => r.toLowerCase().includes("has not moved"))).toBe(true);
  });

  // Milestone 12.5: HOLD's own LLM instruction now explicitly steers
  // phrasing toward firmness — this is the only change; the deterministic
  // decision above (still HOLD, still repeating 43700) is completely
  // unaffected. Verified against the real instruction string
  // runBuyerAgent actually sends the LLM provider for a genuine HOLD
  // round (not a live Gemini call, which this codebase's own tests never
  // make — see this file's own provider mock — but the exact same
  // mocking boundary every other prompt-content assertion in this test
  // suite already relies on).
  it("HOLD's LLM instruction explicitly requires firmness phrasing and forbids 'I can go up to' language", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");

    await runBuyerAgent(
      constraints,
      manifestProduct,
      stuckMerchantResult,
      { round: 3, maxRounds: 8 },
      { priorMerchantUnitPrice: 46500, previousBuyerUnitPrice: 43700 }, // merchant's offer unchanged -> HOLD
    );

    const [{ instruction }] = mockedGenerateAgentMessage.mock.calls[0];
    expect(instruction).toMatch(/holding its position/i);
    expect(instruction).toMatch(/firmness/i);
    expect(instruction.toLowerCase()).toContain("i can go up to");
    expect(instruction).toMatch(/must not use language like/i);
  });

  it("B: concedes (a controlled, clamped move) when the merchant did move", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");

    const response = await runBuyerAgent(
      constraints,
      manifestProduct,
      stuckMerchantResult,
      { round: 3, maxRounds: 8 },
      { priorMerchantUnitPrice: 47200, previousBuyerUnitPrice: 43700 }, // merchant improved from 47200 -> 46500
    );

    expect(response.action.type).toBe("counter_offer");
    expect(response.action.unitPrice).toBeGreaterThan(43700);
    expect(response.action.unitPrice).toBeLessThanOrEqual(constraints.maxUnitPrice);
  });

  // E. Same buyer state, different merchant movement -> different decision.
  it("E: identical buyer state produces a different action depending only on whether the merchant moved", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");
    const context = { round: 3, maxRounds: 8 } as const;

    const merchantMoved = await runBuyerAgent(constraints, manifestProduct, stuckMerchantResult, context, {
      priorMerchantUnitPrice: 47200,
      previousBuyerUnitPrice: 43700,
    });
    const merchantStalled = await runBuyerAgent(constraints, manifestProduct, stuckMerchantResult, context, {
      priorMerchantUnitPrice: 46500,
      previousBuyerUnitPrice: 43700,
    });

    expect(merchantMoved.action.unitPrice).not.toBe(merchantStalled.action.unitPrice);
    expect(merchantStalled.action.unitPrice).toBe(43700); // held
  });

  // F. Leverage shifts the decision while staying within hard constraints.
  //
  // quantityTradeAlreadyUsed: true isolates this Milestone-3-era test
  // from Milestone 6's independent leverage-modulated quantity-trade
  // mechanism (which, since strong leverage is no longer excluded from
  // it, would otherwise also become eligible at leverageScore 85 here) —
  // this test's own purpose is specifically the HOLD/CONCEDE leverage
  // behavior in isolation, unchanged from Milestone 3.
  it("F: higher buyer leverage shifts the decision toward holding, without ever exceeding maxUnitPrice", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");
    const context = { round: 3, maxRounds: 8 } as const;
    const history = {
      priorMerchantUnitPrice: 47200,
      previousBuyerUnitPrice: 43700,
      quantityTradeAlreadyUsed: true,
    }; // merchant moved slightly

    const lowLeverage = await runBuyerAgent(constraints, manifestProduct, stuckMerchantResult, context, {
      ...history,
      leverageScore: 15,
    });
    const highLeverage = await runBuyerAgent(constraints, manifestProduct, stuckMerchantResult, context, {
      ...history,
      leverageScore: 85,
    });

    expect(highLeverage.action.unitPrice).toBe(43700); // held despite the merchant moving
    expect(lowLeverage.action.unitPrice).not.toBe(43700); // conceded
    expect(lowLeverage.action.unitPrice).toBeLessThanOrEqual(constraints.maxUnitPrice);
    expect(highLeverage.action.unitPrice).toBeLessThanOrEqual(constraints.maxUnitPrice);
  });

  it("still concedes to the true ceiling in the final rounds regardless of leverage or merchant movement", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");

    const response = await runBuyerAgent(
      constraints,
      manifestProduct,
      stuckMerchantResult,
      { round: 7, maxRounds: 8 }, // roundsLeft = 2
      { priorMerchantUnitPrice: 46500, previousBuyerUnitPrice: 43700, leverageScore: 95 },
    );

    expect(response.action.unitPrice).toBe(constraints.maxUnitPrice);
  });
});

// PACT V2 Milestone 5: buyer-initiated quantity-for-price bargaining,
// wired through the real runBuyerAgent (not just buyerQuantityTrade.ts's
// own isolated unit tests) — proves the plumbing (strategyContext.leverageScore
// + quantityTradeAlreadyUsed) actually reaches the decision, and that the
// LLM boundary safely communicates the conditional trade.
describe("runBuyerAgent — quantity-for-price bargaining strategy", () => {
  const tradeConstraints: BuyerConstraints = {
    sku: "LAPTOP-14-I5",
    quantity: 50,
    maxUnitPrice: 45500,
    deliveryDeadlineDays: 10,
    urgency: "high",
  };
  // Verified empirically against the real orchestrator's golden
  // trajectory (see orchestrator.test.ts) — not hand-derived.
  const merchantResult: NegotiationResult = {
    outcome: "COUNTER_OFFER",
    sku: "LAPTOP-14-I5",
    requestedQuantity: 50,
    offeredQuantity: 50,
    unitPrice: 45613,
    deliveryDays: 10,
    reasons: [],
  };

  it("proposes QUANTITY_FOR_PRICE at moderate leverage, exposing tradeMove and the reason", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");

    const response = await runBuyerAgent(
      tradeConstraints,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 },
      { leverageScore: 54, quantityTradeAlreadyUsed: false },
    );

    expect(response.tradeMove).toBe("QUANTITY_FOR_PRICE");
    expect(response.action).toEqual({
      type: "counter_offer",
      sku: "LAPTOP-14-I5",
      quantity: 57,
      unitPrice: 43225,
      deliveryDays: 10,
    });
    expect(response.strategicReasons.some((r) => r.includes("increase the order to 57 units"))).toBe(true);
  });

  // Milestone 6: a high-leverage buyer is NOT excluded from the trade by
  // ELIGIBILITY — the old leverage-band gate was found (via real browser
  // testing) to incorrectly block exactly this case. Leverage instead
  // sizes a MORE aggressive ask than the moderate-leverage case above.
  //
  // Milestone 9: eligibility alone is no longer the whole story — the
  // trade candidate is generated here exactly as before, but now has to
  // WIN a genuine comparison against the buyer's ordinary candidate too.
  //
  // Buyer Quantity-for-Price Redesign — re-verified live: on this exact
  // fixture, the natural (uncapped) trade price already floor-clamps to
  // the buyer's own target (43225) at BOTH moderate and strong leverage
  // — the 44700 previous-price ceiling never actually needs to bind, so
  // the two leverage levels produce an IDENTICAL price here (a real,
  // disclosed consequence of the floor dominating on this fixture — see
  // buyerQuantityTrade.test.ts's own direct resolver-level tests for
  // leverage's genuine, continuous, non-degenerate effect on price,
  // isolated from this kind of clamping). What strong leverage still
  // reliably demonstrates on THIS fixture is that the trade continues to
  // win the comparison and never breaches the previous-price ceiling.
  it("still trades at strong leverage, respecting the previous-price ceiling (floor-clamped identically to moderate leverage on this fixture)", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");

    const response = await runBuyerAgent(
      tradeConstraints,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 },
      { leverageScore: 90, quantityTradeAlreadyUsed: false, previousBuyerUnitPrice: 44700 },
    );

    expect(response.tradeMove).toBe("QUANTITY_FOR_PRICE");
    expect(response.action.quantity).toBe(57);
    expect(response.action.unitPrice).toBe(43225);
    expect(response.action.unitPrice!).toBeLessThanOrEqual(44700); // never exceeds the buyer's own previous ask
  });

  // Milestone 9: the flip side of the same comparison, proven directly —
  // a strongly-leveraged buyer with NO prior price on record (its own
  // aspirational target, not an already-conceded number) can afford to
  // just HOLD at that target rather than trade anything away, since the
  // target itself already beats what the trade would ask for. This is
  // the comparator genuinely working, not a regression: the trade is
  // still generated (confirmed by the previous test using the identical
  // leverage), it simply loses to a better ordinary candidate here.
  it("prefers HOLD over the trade when holding at the buyer's own target is already the better price", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");

    const response = await runBuyerAgent(
      tradeConstraints,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 },
      { leverageScore: 90, quantityTradeAlreadyUsed: false }, // no previousBuyerUnitPrice -> HOLD falls back to the buyer's own target
    );

    expect(response.tradeMove).toBe("NO_TRADE");
    expect(response.move).toBe("HOLD");
    expect(response.action.unitPrice).toBe(43225); // resolveBuyerTarget(tradeConstraints) — cheaper than the 43640 trade ask
    expect(response.action.quantity).toBe(50); // unchanged — the trade was correctly outranked, not merely skipped
  });

  it("does not trade once the chip has already been used, even at otherwise-favorable leverage", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");

    const response = await runBuyerAgent(
      tradeConstraints,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 },
      { leverageScore: 54, quantityTradeAlreadyUsed: true },
    );

    expect(response.tradeMove).toBe("NO_TRADE");
    expect(response.action.quantity).toBe(50);
  });

  // 13. LLM message contains all required conditional-trade numbers.
  it("passes through an LLM message that correctly states the conditional trade's quantity, price, and delivery", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      "I'll take 57 units if you can bring the price down to 43225 each, delivered within 10 days.",
    );

    const response = await runBuyerAgent(
      tradeConstraints,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 },
      { leverageScore: 54, quantityTradeAlreadyUsed: false },
    );

    expect(response.message).toBe(
      "I'll take 57 units if you can bring the price down to 43225 each, delivered within 10 days.",
    );
  });

  // 14. Invalid Gemini conditional message falls back deterministically.
  it("falls back to a deterministic message when the LLM's conditional-trade text omits the required price", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("I'll take more units if you can help on price.");

    const response = await runBuyerAgent(
      tradeConstraints,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 },
      { leverageScore: 54, quantityTradeAlreadyUsed: false },
    );

    // The structured decision itself is completely unaffected...
    expect(response.action.quantity).toBe(57);
    expect(response.action.unitPrice).toBe(43225);
    // ...but the fallback caption states the real numbers, not the vague LLM text.
    expect(response.message).toContain("57");
    expect(response.message).toContain("43225");
    expect(response.message).not.toContain("help on price");
  });

  it("falls back to a deterministic message when the LLM invents a conditional-trade quantity not in the context", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("I'll take 99999 units if you can do 1 each.");

    const response = await runBuyerAgent(
      tradeConstraints,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 },
      { leverageScore: 54, quantityTradeAlreadyUsed: false },
    );

    expect(response.action.quantity).toBe(57); // structured value unaffected
    expect(response.message).not.toContain("99999");
    expect(response.message).not.toContain("1 each");
    expect(response.message).toContain("57");
    expect(response.message).toContain("43225");
  });
});

// PACT V2 Milestone 7: buyer-initiated delivery-for-price bargaining,
// wired through the real runBuyerAgent (not just buyerDeliveryTrade.ts's
// own isolated unit tests) — proves the plumbing (strategyContext.leverageScore
// + deliveryTradeAlreadyUsed) actually reaches the decision, that it
// stays independent of the quantity chip, and that the LLM boundary
// safely communicates the conditional trade. Fixture mirrors the real
// orchestrator's own golden trajectory (see orchestrator.test.ts) — not
// hand-derived.
describe("runBuyerAgent — delivery-for-price bargaining strategy", () => {
  const deliveryTradeConstraints: BuyerConstraints = {
    sku: "LAPTOP-14-I5",
    quantity: 40,
    maxUnitPrice: 45500,
    deliveryDeadlineDays: 8,
    urgency: "high",
    deliveryFlexible: true,
  };
  const merchantResult: NegotiationResult = {
    outcome: "PARTIAL_FULFILLMENT",
    sku: "LAPTOP-14-I5",
    requestedQuantity: 40,
    offeredQuantity: 30, // supply-constrained -> the quantity chip is unavailable, isolating delivery cleanly
    unitPrice: 46209,
    deliveryDays: 8,
    reasons: [],
  };

  it("proposes DELIVERY_FOR_PRICE when the quantity chip is unavailable but delivery flexibility was stated", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");

    const response = await runBuyerAgent(
      deliveryTradeConstraints,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 },
      { leverageScore: 26, deliveryTradeAlreadyUsed: false },
    );

    expect(response.tradeMove).toBe("DELIVERY_FOR_PRICE");
    expect(response.action).toEqual({
      type: "counter_offer",
      sku: "LAPTOP-14-I5",
      quantity: 30, // still adopts the merchant's supply-constrained quantity
      unitPrice: 44625,
      deliveryDays: 10, // 8 + round(8 * 0.3) — resolveDeliveryUrgencyFactor("high"), negotiation calibration task
    });
    expect(response.strategicReasons.some((r) => r.includes("accept delivery in 10 days"))).toBe(true);
  });

  it("does not trade delivery when the buyer never indicated flexibility", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");
    const inflexible: BuyerConstraints = { ...deliveryTradeConstraints, deliveryFlexible: false };

    const response = await runBuyerAgent(
      inflexible,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 },
      { leverageScore: 26, deliveryTradeAlreadyUsed: false },
    );

    expect(response.tradeMove).toBe("NO_TRADE");
    expect(response.action.deliveryDays).toBe(8); // unchanged — no trade attempted
  });

  it("does not trade delivery once the chip has already been used, even at otherwise-favorable leverage", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");

    const response = await runBuyerAgent(
      deliveryTradeConstraints,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 },
      { leverageScore: 26, deliveryTradeAlreadyUsed: true },
    );

    expect(response.tradeMove).toBe("NO_TRADE");
    expect(response.action.deliveryDays).toBe(8);
  });

  // Milestone 12: when BOTH chips are simultaneously eligible (the
  // merchant is no longer short-supplying the original request, AND
  // delivery flexibility was stated), the buyer no longer fires just
  // one of the two solo trades in isolation — the combined
  // quantity+delivery package (buyerQuantityAndDeliveryTrade.ts) is now
  // ALSO generated as a third candidate, competing on price via the
  // existing, unmodified compareBuyerPackages — never a new priority
  // rule. This was "never fires the delivery chip in the same round the
  // quantity chip fires" pre-Milestone-12, when only two solo trades
  // existed.
  //
  // Buyer Quantity-for-Price Redesign — re-verified live: on this exact
  // fixture (weak leverage, 26), the solo QUANTITY_FOR_PRICE candidate
  // now wins instead of the combined package. Root cause, verified
  // directly: the redesigned quantity trade's own price-improvement
  // fraction alone already floor-clamps to the buyer's own target here,
  // so the combined package's additional delivery discount cannot push
  // the price any lower — the two tie on price, and
  // Array.prototype.reduce's first-encountered-wins rule (unmodified)
  // favors QUANTITY_FOR_PRICE, generated before
  // QUANTITY_AND_DELIVERY_FOR_PRICE in generateBuyerCandidates. This is a
  // real, disclosed consequence of the redesign — see
  // buyerQuantityAndDeliveryTrade.test.ts for the combined package's own
  // mechanism proven correct in isolation, and the redesign's final
  // report for the recommendation to revisit
  // QUANTITY_TRADE_MIN_PRICE_IMPROVEMENT_FRACTION if demonstrating the
  // combined package winning end-to-end becomes a priority.
  it("the solo quantity trade wins the price tie against the combined package on this (weak-leverage) fixture", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");
    const fullySupplied: NegotiationResult = { ...merchantResult, offeredQuantity: 40 }; // quantity chip now eligible

    const response = await runBuyerAgent(
      deliveryTradeConstraints,
      manifestProduct,
      fullySupplied,
      { round: 2, maxRounds: 10 },
      { leverageScore: 26, quantityTradeAlreadyUsed: false, deliveryTradeAlreadyUsed: false },
    );

    expect(response.tradeMove).toBe("QUANTITY_FOR_PRICE");
    expect(response.action).toEqual({
      type: "counter_offer",
      sku: "LAPTOP-14-I5",
      quantity: 46,
      unitPrice: 43225,
      deliveryDays: 8, // unchanged — the winning candidate never touched delivery
    });
  });

  // LLM message contains all required conditional-trade numbers.
  it("passes through an LLM message that correctly states the delivery trade's terms", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      "For 30 units, I can accept delivery in 10 days if you can bring the price down to 44625 each.",
    );

    const response = await runBuyerAgent(
      deliveryTradeConstraints,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 },
      { leverageScore: 26, deliveryTradeAlreadyUsed: false },
    );

    expect(response.message).toBe(
      "For 30 units, I can accept delivery in 10 days if you can bring the price down to 44625 each.",
    );
  });

  // Invalid Gemini conditional message falls back deterministically.
  it("falls back to a deterministic message when the LLM's conditional-trade text omits the required price", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("I can wait longer if you help on price.");

    const response = await runBuyerAgent(
      deliveryTradeConstraints,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 },
      { leverageScore: 26, deliveryTradeAlreadyUsed: false },
    );

    // The structured decision itself is completely unaffected...
    expect(response.action.deliveryDays).toBe(10);
    expect(response.action.unitPrice).toBe(44625);
    // ...but the fallback caption states the real numbers, not the vague LLM text.
    expect(response.message).toContain("10");
    expect(response.message).toContain("44625");
    expect(response.message).not.toContain("help on price");
  });

  it("falls back to a deterministic message when the LLM invents a conditional-trade delivery window not in the context", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("I can wait 999 days if you can do 1 each.");

    const response = await runBuyerAgent(
      deliveryTradeConstraints,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 },
      { leverageScore: 26, deliveryTradeAlreadyUsed: false },
    );

    expect(response.action.deliveryDays).toBe(10); // structured value unaffected
    expect(response.message).not.toContain("999");
    expect(response.message).not.toContain("1 each");
    expect(response.message).toContain("10");
    expect(response.message).toContain("44625");
  });
});

// PACT V2 Milestone 6: quantity SUFFICIENCY — a separate question from
// buyerQuantityTrade.ts's bargaining chip. Proves the plumbing through
// the real runBuyerAgent, not just buyerQuantitySufficiency.ts's own
// isolated unit tests (see buyerQuantitySufficiency.test.ts for those).
describe("runBuyerAgent — quantity sufficiency (partial fulfillment is not automatic acceptance)", () => {
  const shortfallConstraints: BuyerConstraints = {
    sku: "LAPTOP-14-I5",
    quantity: 150,
    maxUnitPrice: 47000,
    deliveryDeadlineDays: 10,
    urgency: "medium",
  };

  // 10. A technically acceptable partial fulfillment (within the hard
  // price/quantity-ceiling/delivery constraints) can still lead to a
  // COUNTER instead of an automatic ACCEPT — this is the exact real
  // browser Scenario 2 shape from the Milestone 6 browser-failure review.
  it("a technically acceptable but insufficient partial fulfillment leads to a counter, not an automatic accept", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");
    const merchantResult: NegotiationResult = {
      outcome: "PARTIAL_FULFILLMENT",
      sku: "LAPTOP-14-I5",
      requestedQuantity: 150,
      offeredQuantity: 100, // a 33% shortfall
      unitPrice: 46900, // merely acceptable — close to the ceiling (47000), not a real bargain
      deliveryDays: 10,
      reasons: [],
    };

    const response = await runBuyerAgent(
      shortfallConstraints,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 }, // plenty of rounds left — the final-rounds safety net does not apply
    );

    expect(response.sufficiency).not.toBeNull();
    expect(response.sufficiency!.verdict).toBe("INSUFFICIENT");
    expect(response.action.type).not.toBe("accept");
    expect(response.action.type).toBe("counter_offer");
    expect(response.action.quantity).toBe(100); // still adopts the merchant's offered quantity while negotiating price
  });

  it("the SAME shortfall at a substantially better price IS accepted — the policy weighs price, it doesn't ignore quantity", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");
    const merchantResult: NegotiationResult = {
      outcome: "PARTIAL_FULFILLMENT",
      sku: "LAPTOP-14-I5",
      requestedQuantity: 150,
      offeredQuantity: 100,
      unitPrice: 44900, // substantially better — close to the buyer's own target
      deliveryDays: 10,
      reasons: [],
    };

    const response = await runBuyerAgent(
      shortfallConstraints,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 },
    );

    expect(response.sufficiency!.verdict).toBe("INSUFFICIENT_PRICE_COMPENSATES");
    expect(response.action.type).toBe("accept");
  });

  it("a small shortfall is accepted without needing any price justification", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");
    const merchantResult: NegotiationResult = {
      outcome: "PARTIAL_FULFILLMENT",
      sku: "LAPTOP-14-I5",
      requestedQuantity: 150,
      offeredQuantity: 145, // a 3% shortfall
      unitPrice: 46950, // a poor price — irrelevant here, the shortfall itself is within tolerance
      deliveryDays: 10,
      reasons: [],
    };

    const response = await runBuyerAgent(
      shortfallConstraints,
      manifestProduct,
      merchantResult,
      { round: 2, maxRounds: 10 },
    );

    expect(response.sufficiency!.verdict).toBe("SUFFICIENT");
    expect(response.action.type).toBe("accept");
  });

  // The final-rounds safety net (established since Milestone 2) still
  // guarantees convergence: an otherwise-insufficient shortfall is still
  // accepted once no real negotiating room remains, rather than
  // stranding the negotiation in an unreachable state.
  it("still accepts an insufficient shortfall within the final-rounds safety net, rather than stalling forever", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");
    const merchantResult: NegotiationResult = {
      outcome: "PARTIAL_FULFILLMENT",
      sku: "LAPTOP-14-I5",
      requestedQuantity: 150,
      offeredQuantity: 100,
      unitPrice: 46900, // the same "merely acceptable" price that was rejected earlier in this negotiation
      deliveryDays: 10,
      reasons: [],
    };

    const response = await runBuyerAgent(
      shortfallConstraints,
      manifestProduct,
      merchantResult,
      { round: 9, maxRounds: 10 }, // roundsLeft = 2 -> the safety net
    );

    expect(response.action.type).toBe("accept");
  });

  // Single-shot callers that predate Phase 5B's round-aware system never
  // had a "try again next round" option to begin with — sufficiency
  // must not newly block them either.
  it("does not apply sufficiency at all for a single-shot caller without a round context", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");
    const merchantResult: NegotiationResult = {
      outcome: "PARTIAL_FULFILLMENT",
      sku: "LAPTOP-14-I5",
      requestedQuantity: 150,
      offeredQuantity: 100,
      unitPrice: 46900,
      deliveryDays: 10,
      reasons: [],
    };

    const response = await runBuyerAgent(shortfallConstraints, manifestProduct, merchantResult);

    expect(response.sufficiency).toBeNull();
    expect(response.action.type).toBe("accept");
  });
});

// PACT V2 Milestone 2: the buyer's deterministic walk-away decision.
describe("runBuyerWalkAway", () => {
  it("the message states the buyer's own maximum budget and the merchant's offer that exceeded it", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      "44000 per unit is above my maximum budget of 30000, so I can't proceed.",
    );

    const { message } = await runBuyerWalkAway(
      { ...constraints, maxUnitPrice: 30000 },
      44000,
      "price_gap_unbridgeable",
    );

    expect(message).toContain("30000");
    expect(message).toContain("44000");
  });

  it("falls back to a deterministic message when the LLM response fails integrity validation", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("*** a Sentence");

    const { message } = await runBuyerWalkAway(
      { ...constraints, maxUnitPrice: 30000 },
      44000,
      "price_gap_unbridgeable",
    );

    expect(message).not.toContain("***");
    expect(message).toContain("30000");
    expect(message).toContain("44000");
  });

  it("falls back to a deterministic message when no LLM provider is configured", async () => {
    mockedGenerateAgentMessage.mockRejectedValue(new LlmUnavailableError("no key"));

    const { message } = await runBuyerWalkAway(
      { ...constraints, maxUnitPrice: 30000 },
      44000,
      "price_gap_unbridgeable",
    );

    expect(message.length).toBeGreaterThan(0);
    expect(message).toContain("30000");
    expect(message).toContain("44000");
  });

  it("still propagates a non-key-related error instead of masking it", async () => {
    mockedGenerateAgentMessage.mockRejectedValue(new Error("network exploded"));

    await expect(
      runBuyerWalkAway({ ...constraints, maxUnitPrice: 30000 }, 44000, "price_gap_unbridgeable"),
    ).rejects.toThrow("network exploded");
  });

  it("produces a distinct message for a repeated-positions walk-away vs a price-gap walk-away", async () => {
    mockedGenerateAgentMessage.mockRejectedValue(new LlmUnavailableError("no key"));

    const priceGap = await runBuyerWalkAway(
      { ...constraints, maxUnitPrice: 30000 },
      44000,
      "price_gap_unbridgeable",
    );
    const repeated = await runBuyerWalkAway(
      { ...constraints, maxUnitPrice: 30000 },
      44000,
      "repeated_positions",
    );

    expect(priceGap.message).not.toBe(repeated.message);
  });
});
