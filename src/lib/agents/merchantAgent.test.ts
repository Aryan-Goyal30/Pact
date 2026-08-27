import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import { runMerchantAgent } from "./merchantAgent";
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
      expect(scarceResult.decision.reasons.some((r) => r.includes("does not currently justify"))).toBe(
        true,
      );
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
