import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import { runMerchantAgent, runMerchantWalkAway } from "./merchantAgent";
import { getLlmProvider, LlmUnavailableError } from "@/lib/llm/provider";

// The LLM is mocked at the provider boundary for every test in this
// file — no test here makes a real Anthropic API call or spends
// credits. See claude.test.ts for the one test that exercises the real
// (unmocked) missing-API-key path. LlmUnavailableError itself is kept
// real (via importOriginal) so the fallback-message tests below can
// throw something merchantAgent.ts's `instanceof` check actually
// recognizes.
vi.mock("@/lib/llm/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/provider")>();
  return {
    ...actual,
    getLlmProvider: vi.fn(),
  };
});

const mockedGetLlmProvider = vi.mocked(getLlmProvider);
const mockedGenerateAgentMessage = vi.fn();

const item: CatalogItemSnapshot = {
  sku: "LAPTOP-14-I5",
  listedPrice: 48000,
  minPrice: 44000,
  availableQty: 100,
  standardDeliveryDays: 5,
  maxDeliveryDays: 12,
  negotiationEnabled: true,
};

beforeEach(() => {
  mockedGenerateAgentMessage.mockReset();
  mockedGetLlmProvider.mockReturnValue({ generateAgentMessage: mockedGenerateAgentMessage });
});

describe("runMerchantAgent", () => {
  // 1. A valid request produces a merchant-agent response.
  it("produces a full response for a valid exact-match request", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      "We can fulfill your order of 10 units at 48000 each, delivered in 5 days.",
    );

    const response = await runMerchantAgent(item, { sku: item.sku, quantity: 10 });

    expect(response.decision.outcome).toBe("EXACT_MATCH");
    expect(response.offer).toEqual({
      sku: item.sku,
      quantity: 10,
      unitPrice: 48000,
      deliveryDays: 5,
    });
    expect(response.message).toBe(
      "We can fulfill your order of 10 units at 48000 each, delivered in 5 days.",
    );
    expect(mockedGenerateAgentMessage).toHaveBeenCalledTimes(1);
  });

  // 2. A partial-fulfillment result produces a counter-offer message.
  //
  // The mocked message states every required value (quantity, unit
  // price, delivery days) verbatim — checkAgentMessageIntegrity
  // (messageIntegrity.ts) requires this of every accepted message, so a
  // mock that omitted the price/delivery (as this fixture originally
  // did, before the message-integrity hardening) would now be silently
  // replaced by the deterministic fallback instead of being returned as-is.
  it("produces a partial-fulfillment offer and passes it to the LLM for phrasing", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      "We only have 100 units available, offered at 46500 per unit, delivered in 5 days.",
    );

    const response = await runMerchantAgent(item, {
      sku: item.sku,
      quantity: 200,
      maxUnitPrice: 45000,
      deliveryDeadlineDays: 10,
    });

    expect(response.decision.outcome).toBe("PARTIAL_FULFILLMENT");
    expect(response.offer).toEqual({
      sku: item.sku,
      quantity: 100,
      unitPrice: 46500,
      deliveryDays: 5,
    });
    expect(response.message).toBe(
      "We only have 100 units available, offered at 46500 per unit, delivered in 5 days.",
    );
  });

  // 3. A rejected/impossible request produces a rejection message.
  it("produces a null offer and a rejection message for an impossible request", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      "We're unable to fulfill this request: delivery in 1 day is faster than our standard 5 days.",
    );

    const response = await runMerchantAgent(item, {
      sku: item.sku,
      quantity: 10,
      deliveryDeadlineDays: 1,
    });

    expect(response.decision.outcome).toBe("REJECTED");
    expect(response.offer).toBeNull();
    expect(response.message).toMatch(/unable to fulfill/i);
  });

  // 4. The LLM cannot change the authoritative price or quantity.
  it("ignores whatever numbers the LLM's text contains — decision/offer come only from the engine", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      "We can offer 99999 units at 1 each, delivered tomorrow.",
    );

    const response = await runMerchantAgent(item, { sku: item.sku, quantity: 10 });

    expect(response.decision.offeredQuantity).toBe(10);
    expect(response.decision.unitPrice).toBe(48000);
    expect(response.decision.deliveryDays).toBe(5);
    expect(response.offer).toEqual({
      sku: item.sku,
      quantity: 10,
      unitPrice: 48000,
      deliveryDays: 5,
    });
  });

  // 5. Private minPrice is not passed to the LLM prompt/context.
  it("never includes minPrice (or its value) in the context passed to the LLM", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("...");

    await runMerchantAgent(item, { sku: item.sku, quantity: 10, maxUnitPrice: 45000 });

    expect(mockedGenerateAgentMessage).toHaveBeenCalledTimes(1);
    const input = mockedGenerateAgentMessage.mock.calls[0][0];
    expect(input.context).not.toHaveProperty("minPrice");
    expect(JSON.stringify(input.context)).not.toContain(String(item.minPrice));
  });

  describe("with a concessionContext (multi-round negotiation)", () => {
    it("does not change behavior when omitted — every existing single-shot caller is unaffected", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const response = await runMerchantAgent(item, {
        sku: item.sku,
        quantity: 10,
        maxUnitPrice: 45000,
      });
      expect(response.decision.unitPrice).toBe(46500); // unchanged single-shot midpoint
    });

    it("overrides the price toward the round-aware concession value instead of the flat midpoint", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const response = await runMerchantAgent(
        item,
        { sku: item.sku, quantity: 10, maxUnitPrice: 45000 },
        { round: 2, maxRounds: 4, previousOfferUnitPrice: 46500 },
      );
      expect(response.decision.unitPrice).toBe(45750);
      expect(response.decision.outcome).toBe("COUNTER_OFFER");
    });

    // 1. The merchant does not immediately accept 45000 merely because
    // it is above the floor — round 2 still produces a counter above
    // the buyer's price, not an outright acceptance of it.
    it("still counters (does not jump to accepting) even though the buyer's price is already above the floor", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const response = await runMerchantAgent(
        item,
        { sku: item.sku, quantity: 10, maxUnitPrice: 45000 },
        { round: 2, maxRounds: 4, previousOfferUnitPrice: 46500 },
      );
      expect(response.decision.unitPrice).not.toBe(45000);
      expect(response.decision.unitPrice!).toBeGreaterThan(45000);
      expect(response.offer?.unitPrice).not.toBe(45000);
    });

    // 4. The merchant can never produce a price below minPrice, even
    // with a concessionContext pushing it toward settlement.
    it("never overrides the price to something below minPrice", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const response = await runMerchantAgent(
        item,
        { sku: item.sku, quantity: 10, maxUnitPrice: 1 },
        { round: 4, maxRounds: 4, previousOfferUnitPrice: 44500 },
      );
      expect(response.decision.unitPrice).toBe(item.minPrice);
    });

    // 5, 9. Strategic factors (stock pressure, delivery trade) are
    // recorded as human-readable reasons alongside the structured price.
    it("records a strategic reason when a delivery-for-price trade is applied", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const response = await runMerchantAgent(
        item,
        {
          sku: item.sku,
          quantity: 10,
          maxUnitPrice: 45000,
          deliveryDeadlineDays: 12,
          deliveryFlexible: true,
        },
        { round: 2, maxRounds: 6, previousOfferUnitPrice: 46500 },
      );
      expect(response.decision.deliveryDays).toBeGreaterThan(item.standardDeliveryDays);
      expect(response.decision.reasons.some((r) => r.includes("delivery window"))).toBe(true);
    });

    it("records a strategic reason when high stock pressure increases the concession", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const abundantItem: CatalogItemSnapshot = { ...item, availableQty: 1000 };
      const response = await runMerchantAgent(
        abundantItem,
        { sku: item.sku, quantity: 10, maxUnitPrice: 45000 },
        { round: 2, maxRounds: 6, previousOfferUnitPrice: 46500 },
      );
      expect(response.decision.reasons.some((r) => r.includes("stock pressure"))).toBe(true);
    });

    it("keeps the reasons text consistent with the overridden price, not the original one", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const response = await runMerchantAgent(
        item,
        { sku: item.sku, quantity: 10, maxUnitPrice: 45000 },
        { round: 2, maxRounds: 4, previousOfferUnitPrice: 46500 },
      );
      expect(response.decision.reasons.join(" ")).toContain("45750");
      expect(response.decision.reasons.join(" ")).not.toContain("46500");
    });
  });

  // PACT V2 Milestone 4: the merchant reacts to the buyer's OWN prior
  // move (merchantReciprocity.ts), not just to the buyer's current ask.
  // Same current maxUnitPrice (45000) and the same concessionContext
  // (round 2, previousOfferUnitPrice 46500 -> baseline 45750 with no
  // history signal) throughout; only priorBuyerUnitPrice changes.
  // Exact values verified empirically (see the scratch probe run in this
  // milestone's session), not hand-derived.
  describe("reciprocity (Milestone 4: history-aware, not just current-value)", () => {
    const request = { sku: item.sku, quantity: 10, maxUnitPrice: 45000 };
    const concessionContext = { round: 2, maxRounds: 4, previousOfferUnitPrice: 46500 };

    it("omitting priorBuyerUnitPrice reproduces the pre-Milestone-4 baseline exactly (UNKNOWN, neutral)", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const response = await runMerchantAgent(item, request, concessionContext);
      expect(response.decision.unitPrice).toBe(45750);
    });

    it("a genuine buyer concession (44000 -> 45000) earns a stronger merchant concession than the neutral baseline", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const response = await runMerchantAgent(item, request, concessionContext, 44000);
      expect(response.decision.unitPrice).toBe(45638);
      expect(response.decision.unitPrice!).toBeLessThan(45750);
      expect(response.decision.reasons.some((r) => r.includes("moved toward the merchant"))).toBe(true);
    });

    it("a held buyer position (45000 -> 45000) earns a weaker merchant concession than the neutral baseline", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const response = await runMerchantAgent(item, request, concessionContext, 45000);
      expect(response.decision.unitPrice).toBe(45938);
      expect(response.decision.unitPrice!).toBeGreaterThan(45750);
      expect(response.decision.reasons.some((r) => r.includes("hasn't moved"))).toBe(true);
    });

    it("a withdrawn buyer position (46000 -> 45000) earns the weakest merchant concession of all", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const response = await runMerchantAgent(item, request, concessionContext, 46000);
      expect(response.decision.unitPrice).toBe(46050);
      expect(response.decision.reasons.some((r) => r.includes("moved away from the merchant"))).toBe(true);
    });

    // The headline acceptance criterion: identical current buyer ask,
    // identical everything else, only the buyer's PRIOR ask differs — and
    // the merchant's price differs solely because of that history, not
    // because any input to the price formula itself changed.
    it("the SAME current ask produces genuinely different merchant behavior depending only on buyer history", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const conceded = await runMerchantAgent(item, request, concessionContext, 44000);
      const held = await runMerchantAgent(item, request, concessionContext, 45000);
      const withdrew = await runMerchantAgent(item, request, concessionContext, 46000);

      expect(conceded.decision.unitPrice!).toBeLessThan(held.decision.unitPrice!);
      expect(held.decision.unitPrice!).toBeLessThan(withdrew.decision.unitPrice!);
    });

    it("still respects the final [minPrice, listedPrice] clamp even in the reciprocity-active round range", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const response = await runMerchantAgent(
        item,
        { sku: item.sku, quantity: 10, maxUnitPrice: 1 },
        concessionContext, // round 2 of 4 -> the reciprocity-active branch
        50000, // WITHDREW: current (1) far below prior (50000), most conservative multiplier
      );
      expect(response.decision.unitPrice).toBe(item.minPrice);
    });
  });

  // PACT V2 Milestone 5: buyer-initiated quantity-for-price bargaining,
  // from the MERCHANT's side. The merchant recognizes a genuine
  // round-over-round quantity increase (previousBuyerQuantity) even when
  // the absolute quantity stays below the flat bulk-order threshold
  // (LARGE_ORDER_QUANTITY_THRESHOLD = 300) — see the trigger-widening in
  // applyMerchantConcession and the matching hasGenuineIncrease flag now
  // accepted by merchantTradeEvaluator.evaluateMerchantTrade (Milestone
  // 1's own verdict logic is otherwise completely untouched). Exact
  // values verified empirically against the real deterministic formulas,
  // not hand-derived.
  describe("quantity-for-price trade recognition (Milestone 5)", () => {
    const request = { sku: item.sku, quantity: 100, maxUnitPrice: 44100 };
    const concessionContext = { round: 2, maxRounds: 6, previousOfferUnitPrice: 46000 };
    const previousBuyerQuantity = 50; // the buyer's ask increased 50 -> 100 this round

    // 6. Attractive quantity-for-price trade with abundant stock.
    it("an abundant-stock merchant recognizes the increase (100, below the 300 bulk threshold) and grants a real discount", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };

      const response = await runMerchantAgent(
        abundant,
        request,
        concessionContext,
        undefined,
        previousBuyerQuantity,
      );

      expect(response.decision.outcome).toBe("COUNTER_OFFER");
      expect(response.decision.offeredQuantity).toBe(100);
      expect(response.decision.unitPrice).toBe(44485);
      expect(
        response.decision.reasons.some((r) => r.includes("increased its requested quantity from 50 to 100")),
      ).toBe(true);
      expect(response.decision.reasons.some((r) => r.includes("additional discount"))).toBe(true);
    });

    // 7. Same proposal with scarce stock produces different behavior.
    it("the IDENTICAL proposal against scarce stock produces a materially worse price than abundant stock", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };
      const medium: CatalogItemSnapshot = { ...item, availableQty: 300 };

      const abundantResponse = await runMerchantAgent(
        abundant,
        request,
        concessionContext,
        undefined,
        previousBuyerQuantity,
      );
      const mediumResponse = await runMerchantAgent(
        medium,
        request,
        concessionContext,
        undefined,
        previousBuyerQuantity,
      );

      expect(abundantResponse.decision.unitPrice!).toBeLessThan(mediumResponse.decision.unitPrice!);
      expect(mediumResponse.decision.reasons.some((r) => r.includes("modest additional discount"))).toBe(
        true,
      );
    });

    // Genuinely scarce stock — the existing partial-fulfillment rule
    // (untouched) still governs quantity; the trade evaluator still runs
    // on top of whatever price that path produces.
    it("stock too scarce to fulfill the traded quantity still triggers partial fulfillment, not a full grant", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const scarce: CatalogItemSnapshot = { ...item, availableQty: 40 };

      const response = await runMerchantAgent(
        scarce,
        request,
        concessionContext,
        undefined,
        previousBuyerQuantity,
      );

      expect(response.decision.outcome).toBe("PARTIAL_FULFILLMENT");
      expect(response.decision.offeredQuantity).toBe(40);
      expect(response.decision.reasons.some((r) => r.includes("Only 40 unit(s) available"))).toBe(true);
    });

    // 8. Trade below merchant floor is never accepted.
    it("never grants a trade-evaluated price below minPrice, however attractive the quantity", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };

      const response = await runMerchantAgent(
        abundant,
        { sku: item.sku, quantity: 100, maxUnitPrice: 1 },
        concessionContext,
        undefined,
        previousBuyerQuantity,
      );

      expect(response.decision.unitPrice).toBe(item.minPrice);
    });

    // 9, 10. Merchant can counter (not force an accept) or hold/reject an
    // unattractive package — a genuine increase does not universally
    // translate into "accept immediately."
    it("still counters rather than caving outright, even for a recognized genuine increase", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const medium: CatalogItemSnapshot = { ...item, availableQty: 300 };

      const response = await runMerchantAgent(
        medium,
        request,
        concessionContext,
        undefined,
        previousBuyerQuantity,
      );

      expect(response.decision.outcome).toBe("COUNTER_OFFER");
      expect(response.decision.unitPrice!).toBeGreaterThan(request.maxUnitPrice);
    });

    // A quantity that did NOT genuinely increase (same as last round, or
    // no history at all) never engages the widened trigger — only the
    // flat bulk threshold can, exactly as before this milestone.
    it("does not engage the trade evaluator's genuine-increase path when the quantity did not actually increase", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };

      const sameAsLastRound = await runMerchantAgent(
        abundant,
        request,
        concessionContext,
        undefined,
        100, // identical to request.quantity -> no increase
      );
      const noHistory = await runMerchantAgent(abundant, request, concessionContext, undefined, null);

      for (const response of [sameAsLastRound, noHistory]) {
        expect(response.decision.reasons.some((r) => r.includes("increased its requested quantity"))).toBe(
          false,
        );
        expect(response.decision.reasons.some((r) => r.includes("additional discount"))).toBe(false);
      }
    });

    // 11, 12. Integration: the buyer's trade flows into the merchant's
    // evaluation correctly, and the response is built entirely from
    // structured terms (never from the LLM's own text).
    it("the LLM's invented numbers never leak into the structured decision, even for a trade round", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("We can offer 99999 units at 1 each.");
      const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };

      const response = await runMerchantAgent(
        abundant,
        request,
        concessionContext,
        undefined,
        previousBuyerQuantity,
      );

      expect(response.decision.offeredQuantity).toBe(100);
      expect(response.decision.unitPrice).toBe(44485);
      expect(response.offer).toEqual({
        sku: item.sku,
        quantity: 100,
        unitPrice: 44485,
        deliveryDays: item.standardDeliveryDays,
      });
    });
  });

  // PACT V2 Milestone 7: buyer-initiated delivery-for-price bargaining,
  // from the MERCHANT's side. The merchant recognizes a genuine
  // round-over-round delivery EXTENSION (previousBuyerDeliveryDays) and
  // evaluates it via its own dedicated module
  // (merchantDeliveryTradeEvaluator.ts), never merchantTradeEvaluator.ts
  // (quantity's own file, deliberately untouched by this milestone).
  // Exact values verified empirically, not hand-derived.
  describe("delivery-for-price trade recognition (Milestone 7)", () => {
    const request = {
      sku: item.sku,
      quantity: 10,
      maxUnitPrice: 44700,
      deliveryDeadlineDays: 12, // extended from a prior 8-day ask
      deliveryFlexible: true,
    };
    const concessionContext = { round: 2, maxRounds: 6, previousOfferUnitPrice: 46000 };
    const previousBuyerDeliveryDays = 8;

    // "different Merchant states produce different delivery-trade evaluations"
    it("a constrained-stock merchant recognizes the extension and grants a real discount", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const constrained: CatalogItemSnapshot = { ...item, availableQty: 15 };

      const response = await runMerchantAgent(
        constrained,
        request,
        concessionContext,
        undefined,
        undefined,
        previousBuyerDeliveryDays,
      );

      expect(response.decision.outcome).toBe("COUNTER_OFFER");
      expect(response.decision.deliveryDays).toBe(12);
      expect(response.decision.unitPrice).toBe(45055);
      expect(
        response.decision.reasons.some((r) => r.includes("offered a longer delivery window (from 8 to 12")),
      ).toBe(true);
      expect(response.decision.reasons.some((r) => r.includes("genuinely valuable"))).toBe(true);
    });

    it("the IDENTICAL proposal against abundant stock produces a materially worse price than constrained stock", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const constrained: CatalogItemSnapshot = { ...item, availableQty: 15 };
      const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };

      const constrainedResponse = await runMerchantAgent(
        constrained,
        request,
        concessionContext,
        undefined,
        undefined,
        previousBuyerDeliveryDays,
      );
      const abundantResponse = await runMerchantAgent(
        abundant,
        request,
        concessionContext,
        undefined,
        undefined,
        previousBuyerDeliveryDays,
      );

      expect(constrainedResponse.decision.unitPrice!).toBeLessThan(abundantResponse.decision.unitPrice!);
      expect(
        abundantResponse.decision.reasons.some((r) => r.includes("no real operational value")),
      ).toBe(true);
    });

    it("never grants a delivery-traded price below minPrice, however generous the extension", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const constrained: CatalogItemSnapshot = { ...item, availableQty: 15 };

      const response = await runMerchantAgent(
        constrained,
        { ...request, maxUnitPrice: 1 },
        concessionContext,
        undefined,
        undefined,
        previousBuyerDeliveryDays,
      );

      expect(response.decision.unitPrice).toBe(item.minPrice);
    });

    it("still counters rather than caving outright, even for a recognized genuine extension", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const medium: CatalogItemSnapshot = { ...item, availableQty: 300 };

      const response = await runMerchantAgent(
        medium,
        request,
        concessionContext,
        undefined,
        undefined,
        previousBuyerDeliveryDays,
      );

      expect(response.decision.outcome).toBe("COUNTER_OFFER");
      expect(response.decision.unitPrice!).toBeGreaterThan(request.maxUnitPrice);
    });

    // "delivery trade does not fire when unnecessary"
    it("does not engage the delivery evaluator when the delivery ask did not actually increase", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const constrained: CatalogItemSnapshot = { ...item, availableQty: 15 };

      const sameAsLastRound = await runMerchantAgent(
        constrained,
        request,
        concessionContext,
        undefined,
        undefined,
        12, // identical to request.deliveryDeadlineDays -> no increase
      );
      const noHistory = await runMerchantAgent(
        constrained,
        request,
        concessionContext,
        undefined,
        undefined,
        null,
      );

      for (const response of [sameAsLastRound, noHistory]) {
        expect(
          response.decision.reasons.some((r) => r.includes("offered a longer delivery window")),
        ).toBe(false);
      }
    });

    // Milestone 12: when BOTH a genuine quantity increase AND a genuine
    // delivery extension are signaled together in the same round, the
    // merchant no longer evaluates them as two competing, mutually
    // exclusive solo trades — the combined package
    // (merchantPackageTradeEvaluator.ts) is now ALSO generated as a
    // third candidate and, at abundant stock, correctly wins (its own
    // quantity term is real value; its own delivery term contributes
    // nothing, mirroring evaluateMerchantDeliveryTrade's own
    // abundant-stock behavior exactly). This was "quantity takes
    // priority" pre-Milestone-12, when only two solo trades existed and
    // quantity's own price happened to win the comparison; now the
    // combined package is the genuinely best available candidate.
    it("evaluates BOTH trade dimensions together as one combined package when both genuinely increase in the same round", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000, maxDeliveryDays: 20 };
      const bulkRequest = { ...request, quantity: 350 }; // >= LARGE_ORDER_QUANTITY_THRESHOLD -> quantity trade engages

      const response = await runMerchantAgent(
        abundant,
        bulkRequest,
        concessionContext,
        undefined,
        300, // genuine quantity increase
        previousBuyerDeliveryDays, // AND a genuine delivery increase, together
      );

      expect(response.move).toBe("QUANTITY_AND_DELIVERY_FOR_PRICE");
      expect(response.decision.unitPrice).toBe(44875);
      expect(
        response.decision.reasons.some(
          (r) => r.includes("increased its requested quantity") && r.includes("offered a longer delivery window"),
        ),
      ).toBe(true);
      // Abundant stock: the combined evaluator's own reason correctly
      // attributes the value to quantity alone, mirroring
      // evaluateMerchantDeliveryTrade's own "no real operational value"
      // finding for abundant stock, now expressed jointly.
      expect(
        response.decision.reasons.some((r) => r.includes("delivery window offered has little additional value")),
      ).toBe(true);
    });
  });

  // PACT V2 Milestone 1: the merchant's conditional quantity <-> price
  // trade evaluator (merchantTradeEvaluator.ts), flowing through the
  // real agent rather than just its own isolated unit tests.
  describe("conditional quantity <-> price trade (real merchant bargaining)", () => {
    const bulkQuantity = 300; // LARGE_ORDER_QUANTITY_THRESHOLD

    it("a bulk order against abundant stock earns a materially better price than the plain baseline", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };

      const withoutBulk = await runMerchantAgent(
        abundant,
        { sku: item.sku, quantity: 10, maxUnitPrice: 44100 },
        { round: 2, maxRounds: 6, previousOfferUnitPrice: 45600 },
      );
      const withBulk = await runMerchantAgent(
        abundant,
        { sku: item.sku, quantity: bulkQuantity, maxUnitPrice: 44100 },
        { round: 2, maxRounds: 6, previousOfferUnitPrice: 45600 },
      );

      expect(withBulk.decision.unitPrice!).toBeLessThan(withoutBulk.decision.unitPrice!);
      expect(withBulk.decision.reasons.some((r) => r.includes("order size"))).toBe(true);
    });

    // The core requirement: the IDENTICAL bulk order/price proposal
    // produces a materially different merchant price depending only on
    // the merchant's own stock — not a universal "more units = cheaper" rule.
    it("the identical bulk proposal produces a materially different price when stock is scarce vs abundant", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };
      const scarce: CatalogItemSnapshot = { ...item, availableQty: 15 };
      const request = { sku: item.sku, quantity: bulkQuantity, maxUnitPrice: 44100 };
      const concessionContext = { round: 2, maxRounds: 6, previousOfferUnitPrice: 45600 };

      const abundantResult = await runMerchantAgent(abundant, request, concessionContext);
      const scarceResult = await runMerchantAgent(scarce, request, concessionContext);

      expect(abundantResult.decision.unitPrice!).toBeLessThan(scarceResult.decision.unitPrice!);
      // Milestone 9: scarce stock now ALSO independently justifies the
      // merchant's own HOLD candidate (merchantMoveSelection.ts), not
      // just the quantity evaluator's own "does not currently justify an
      // additional discount" HOLD verdict — and HOLD's price (the
      // merchant's last, higher offer, 45600) legitimately beats that
      // verdict's own quantity-blind concession under genuine price
      // comparison. This is the milestone's own new capability
      // ("merchant can prefer HOLD... remains asymmetric") demonstrating
      // itself in a pre-existing scarce-stock fixture — the winning
      // reason changed accordingly; the quantity evaluator's specific
      // insight is still computed and folded into the losing CONCEDE
      // candidate, just no longer the one stated when HOLD wins outright.
      expect(scarceResult.decision.reasons.some((r) => r.includes("not reciprocating"))).toBe(true);
    });

    it("a conditional counter states both the quantity context and the price — not a bare number", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      // availableQty exactly matches the requested bulk quantity: fully
      // fulfillable (a plain COUNTER_OFFER, not PARTIAL_FULFILLMENT) and
      // still squarely in the "medium" stock-pressure band.
      const medium: CatalogItemSnapshot = { ...item, availableQty: bulkQuantity };

      const response = await runMerchantAgent(
        medium,
        { sku: item.sku, quantity: bulkQuantity, maxUnitPrice: 44200 },
        { round: 2, maxRounds: 6, previousOfferUnitPrice: 45600 },
      );

      expect(response.decision.outcome).toBe("COUNTER_OFFER");
      expect(
        response.decision.reasons.some((r) => r.includes("order size justifies")),
      ).toBe(true);
    });

    it("a generous enough proposal against abundant stock is accepted at the buyer's own price", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };

      const response = await runMerchantAgent(
        abundant,
        { sku: item.sku, quantity: bulkQuantity, maxUnitPrice: 45500 },
        { round: 2, maxRounds: 6, previousOfferUnitPrice: 45600 },
      );

      expect(response.decision.unitPrice).toBe(45500);
      expect(response.decision.reasons.some((r) => r.includes("attractive given available stock"))).toBe(
        true,
      );
    });

    // Never below the floor, even for a maximally attractive bulk trade.
    it("never grants a trade-evaluated price below minPrice", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const abundant: CatalogItemSnapshot = { ...item, availableQty: 100000 };

      const response = await runMerchantAgent(
        abundant,
        { sku: item.sku, quantity: 100000, maxUnitPrice: 1 },
        { round: 2, maxRounds: 6, previousOfferUnitPrice: 44500 },
      );

      expect(response.decision.unitPrice!).toBeGreaterThanOrEqual(item.minPrice);
    });

    // Merchant strategy is genuinely different from the buyer's — the
    // buyer's own concession math (buyerRules.ts) has no notion of stock
    // pressure or order-value trade evaluation at all; asymmetric
    // objectives, not a mirrored formula.
    it("merchant strategy consults stock pressure that the buyer's own concession formula has no concept of", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("...");
      const scarce: CatalogItemSnapshot = { ...item, availableQty: 15 };
      const concessionContext = { round: 2, maxRounds: 6, previousOfferUnitPrice: 45600 };

      // Scarce stock's HOLD verdict grants zero additional quantity
      // discount — so a bulk request and a small request receive the
      // IDENTICAL price under otherwise-identical conditions, proven
      // without hand-computing the underlying speed-factor arithmetic.
      const bulkResult = await runMerchantAgent(
        scarce,
        { sku: item.sku, quantity: bulkQuantity, maxUnitPrice: 44100 },
        concessionContext,
      );
      const smallResult = await runMerchantAgent(
        scarce,
        { sku: item.sku, quantity: 10, maxUnitPrice: 44100 },
        concessionContext,
      );

      expect(bulkResult.decision.unitPrice).toBe(smallResult.decision.unitPrice);
    });
  });

  // Message-integrity hardening: a malformed/conflicting LLM message
  // must never reach the caller — the negotiation itself must not fail
  // either way, only the prose falls back.
  describe("message integrity", () => {
    it("falls back to a deterministic message when the LLM truncates the price (45,375 -> 45,37)", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("Your price of 45,37 has been noted.");

      const response = await runMerchantAgent(
        item,
        { sku: item.sku, quantity: 10, maxUnitPrice: 45000 },
        { round: 2, maxRounds: 4, previousOfferUnitPrice: 46500 },
      );

      expect(response.decision.unitPrice).toBe(45750); // structured value unaffected
      expect(response.message).not.toContain("45,37 ");
      expect(response.message).toContain("45750"); // the deterministic fallback states the real price in full
    });

    it("falls back to a deterministic message when the LLM invents a quantity", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("We can offer 10 units at 48000 each, delivered tomorrow.");

      const response = await runMerchantAgent(item, { sku: item.sku, quantity: 10 });

      expect(response.decision.offeredQuantity).toBe(10); // coincidentally correct structurally
      // But the message conflated quantity with an invented "delivered
      // tomorrow" and a wrong price context — the LLM text is rejected
      // wholesale because it contains no verifiable per-unit price at all.
      expect(response.message).toBe(
        "We can offer 10 unit(s) at 48000 per unit, delivered in 5 day(s).",
      );
    });

    it("falls back to a deterministic message on garbled LLM output", async () => {
      mockedGenerateAgentMessage.mockResolvedValue("*** a Sentence");

      const response = await runMerchantAgent(item, { sku: item.sku, quantity: 10 });

      expect(response.decision.outcome).toBe("EXACT_MATCH"); // negotiation itself is unaffected
      expect(response.message).not.toContain("***");
      expect(response.message.length).toBeGreaterThan(0);
    });

    it("an acceptance (EXACT_MATCH) message references the actual accepted quantity/price/delivery", async () => {
      mockedGenerateAgentMessage.mockResolvedValue(
        "We can fulfill your order in full: 10 units at 48000 per unit, delivered in 5 days.",
      );

      const response = await runMerchantAgent(item, { sku: item.sku, quantity: 10 });

      expect(response.message).toContain("10");
      expect(response.message).toContain("48000");
      expect(response.message).toContain("5");
    });
  });

  describe("when no LLM provider is configured", () => {
    it("falls back to a deterministic, non-empty message instead of throwing", async () => {
      mockedGenerateAgentMessage.mockRejectedValue(new LlmUnavailableError("no key"));

      const response = await runMerchantAgent(item, { sku: item.sku, quantity: 10 });

      expect(response.message.length).toBeGreaterThan(0);
      expect(response.message).toContain("48000"); // the real, unfabricated listed price
      // The decision itself is completely unaffected by the fallback.
      expect(response.decision.outcome).toBe("EXACT_MATCH");
      expect(response.offer).toEqual({
        sku: item.sku,
        quantity: 10,
        unitPrice: 48000,
        deliveryDays: 5,
      });
    });

    it("includes the real rejection reasons in the fallback message, not fabricated ones", async () => {
      mockedGenerateAgentMessage.mockRejectedValue(new LlmUnavailableError("no key"));

      const response = await runMerchantAgent(item, {
        sku: item.sku,
        quantity: 10,
        deliveryDeadlineDays: 1,
      });

      expect(response.decision.outcome).toBe("REJECTED");
      expect(response.message).toMatch(/faster than the merchant's standard/i);
    });

    it("still propagates a non-key-related error instead of masking it", async () => {
      mockedGenerateAgentMessage.mockRejectedValue(new Error("network exploded"));

      await expect(runMerchantAgent(item, { sku: item.sku, quantity: 10 })).rejects.toThrow(
        "network exploded",
      );
    });
  });
});

// PACT V2 Milestone 2: the merchant's deterministic walk-away decision.
describe("runMerchantWalkAway", () => {
  it("the message communicates inability to meet the buyer's ask, without ever stating a private minimum", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      "We understand, but we're unable to meet 30000 per unit for this order while remaining viable.",
    );

    const { message } = await runMerchantWalkAway(30000, "price_gap_unbridgeable");

    expect(message).toContain("30000");
    expect(message).not.toContain("44000"); // the seeded LAPTOP-14-I5 private floor must never appear
  });

  it("falls back to a deterministic message when the LLM response fails integrity validation", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("*** a Sentence");

    const { message } = await runMerchantWalkAway(30000, "price_gap_unbridgeable");

    expect(message).not.toContain("***");
    expect(message).toContain("30000");
  });

  it("falls back to a deterministic message when no LLM provider is configured", async () => {
    mockedGenerateAgentMessage.mockRejectedValue(new LlmUnavailableError("no key"));

    const { message } = await runMerchantWalkAway(30000, "price_gap_unbridgeable");

    expect(message.length).toBeGreaterThan(0);
    expect(message).toContain("30000");
  });

  it("still propagates a non-key-related error instead of masking it", async () => {
    mockedGenerateAgentMessage.mockRejectedValue(new Error("network exploded"));

    await expect(runMerchantWalkAway(30000, "price_gap_unbridgeable")).rejects.toThrow(
      "network exploded",
    );
  });

  it("produces a distinct message for a repeated-positions walk-away vs a price-gap walk-away", async () => {
    mockedGenerateAgentMessage.mockRejectedValue(new LlmUnavailableError("no key"));

    const priceGap = await runMerchantWalkAway(30000, "price_gap_unbridgeable");
    const repeated = await runMerchantWalkAway(30000, "repeated_positions");

    expect(priceGap.message).not.toBe(repeated.message);
  });
});

// PACT V2 Milestone 10: move observability — MerchantAgentResponse.move
// carries exactly the candidate merchantMoveSelection.ts already selected
// (see applyMerchantConcession in merchantAgent.ts), never a recomputed
// or inferred value. Every fixture below is reused verbatim from an
// already-passing describe block elsewhere in this file (or, for the
// no-op tie case, empirically probed the same way every other pinned
// value in this codebase is) — nothing here is hand-derived.
describe("Milestone 10: move observability (MerchantAgentResponse.move)", () => {
  beforeEach(() => {
    mockedGenerateAgentMessage.mockResolvedValue("...");
  });

  it("a quantity-for-price trade round reports move === QUANTITY_FOR_PRICE", async () => {
    const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };
    const response = await runMerchantAgent(
      abundant,
      { sku: item.sku, quantity: 300, maxUnitPrice: 44100 },
      { round: 2, maxRounds: 6, previousOfferUnitPrice: 45600 },
    );
    expect(response.move).toBe("QUANTITY_FOR_PRICE");
    expect(response.decision.unitPrice).toBe(44345);
  });

  it("a delivery-for-price trade round reports move === DELIVERY_FOR_PRICE", async () => {
    const constrained: CatalogItemSnapshot = { ...item, availableQty: 15, maxDeliveryDays: 20 };
    const response = await runMerchantAgent(
      constrained,
      { sku: item.sku, quantity: 100, maxUnitPrice: 45500, deliveryDeadlineDays: 12, deliveryFlexible: true },
      { round: 2, maxRounds: 6, previousOfferUnitPrice: 46000 },
      undefined,
      undefined,
      8,
    );
    expect(response.move).toBe("DELIVERY_FOR_PRICE");
    expect(response.decision.unitPrice).toBe(45500);
    expect(response.decision.deliveryDays).toBe(12);
  });

  it("a HOLD round (scarce stock, genuine comparison winner) reports move === HOLD", async () => {
    const scarce: CatalogItemSnapshot = { ...item, availableQty: 15 };
    const response = await runMerchantAgent(
      scarce,
      { sku: item.sku, quantity: 300, maxUnitPrice: 44100 },
      { round: 2, maxRounds: 6, previousOfferUnitPrice: 45600 },
    );
    expect(response.move).toBe("HOLD");
    expect(response.decision.unitPrice).toBe(45600);
  });

  it("an ordinary concession round reports move === CONCEDE", async () => {
    const response = await runMerchantAgent(
      item,
      { sku: item.sku, quantity: 10, maxUnitPrice: 45000 },
      { round: 2, maxRounds: 4, previousOfferUnitPrice: 46500 },
      44000,
    );
    expect(response.move).toBe("CONCEDE");
    expect(response.decision.unitPrice).toBe(45638);
  });

  it("a REJECTED outcome (non-negotiable item) never carries a move", async () => {
    const nonNegotiable: CatalogItemSnapshot = { ...item, negotiationEnabled: false };
    const response = await runMerchantAgent(
      nonNegotiable,
      { sku: item.sku, quantity: 10, maxUnitPrice: 1000 },
      { round: 2, maxRounds: 4, previousOfferUnitPrice: 46500 },
    );
    expect(response.decision.outcome).toBe("REJECTED");
    expect(response.move).toBeUndefined();
  });

  it("a single-shot caller (no concessionContext) never carries a move — no candidate selection ran", async () => {
    const response = await runMerchantAgent(item, { sku: item.sku, quantity: 10, maxUnitPrice: 45000 });
    expect(response.decision.outcome).toBe("COUNTER_OFFER");
    expect(response.move).toBeUndefined();
  });

  // The early-return/no-op path identified in the Milestone 10 design
  // review: applyMerchantConcession's own round-aware calculation lands
  // on EXACTLY the same price evaluateNegotiationRequest's single-shot
  // formula already produced (a genuine, reachable tie — round 1, no
  // previousOfferUnitPrice yet), so the function returns `decision`
  // unchanged rather than overriding it. A genuine candidate WAS still
  // selected (CONCEDE) and must not be silently lost just because
  // nothing needed to change numerically.
  it("the no-op tie path (selected price already matches the engine's own baseline) still reports the genuinely selected move", async () => {
    const response = await runMerchantAgent(
      item,
      { sku: item.sku, quantity: 10, maxUnitPrice: 44000 },
      { round: 1, maxRounds: 6 }, // no previousOfferUnitPrice -> reachable tie
    );
    expect(response.decision.unitPrice).toBe(46000);
    expect(response.move).toBe("CONCEDE");
  });
});
