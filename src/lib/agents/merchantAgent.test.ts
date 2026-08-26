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
  it("produces a partial-fulfillment offer and passes it to the LLM for phrasing", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      "We only have 100 units available, offered at an adjusted price.",
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
      "We only have 100 units available, offered at an adjusted price.",
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
