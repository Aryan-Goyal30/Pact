import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import { runMerchantAgent } from "./merchantAgent";
import { getLlmProvider } from "@/lib/llm/provider";

// The LLM is mocked at the provider boundary for every test in this
// file — no test here makes a real Anthropic API call or spends
// credits. See claude.test.ts for the one test that exercises the real
// (unmocked) missing-API-key path.
vi.mock("@/lib/llm/provider", () => ({
  getLlmProvider: vi.fn(),
}));

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
});
