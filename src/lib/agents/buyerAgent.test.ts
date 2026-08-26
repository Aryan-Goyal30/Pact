import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NegotiationResult } from "@/lib/rules/negotiationEngine";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import type { PublicManifestProduct } from "@/types/manifest";
import { runBuyerAgent } from "./buyerAgent";
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
