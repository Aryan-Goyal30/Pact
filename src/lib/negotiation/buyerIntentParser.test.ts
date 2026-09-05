import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLlmProvider, LlmUnavailableError } from "@/lib/llm/provider";
import { buyerIntentToSessionRequest, parseBuyerIntent } from "./buyerIntentParser";
import type { PublicManifestProduct } from "@/types/manifest";

// Same mocking convention as buyerAgent.test.ts / merchantAgent.test.ts
// — the LLM provider boundary is mocked, no real API call is ever made.
vi.mock("@/lib/llm/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/provider")>();
  return { ...actual, getLlmProvider: vi.fn() };
});

const mockedGetLlmProvider = vi.mocked(getLlmProvider);
const mockedGenerateAgentMessage = vi.fn();

beforeEach(() => {
  mockedGenerateAgentMessage.mockReset();
  mockedGetLlmProvider.mockReturnValue({ generateAgentMessage: mockedGenerateAgentMessage });
});

const catalog: PublicManifestProduct[] = [
  {
    sku: "KEYBOARD-WIRELESS",
    name: "Wireless Keyboard & Mouse Combo",
    description: "A wireless keyboard and mouse combo for office use.",
    listedPrice: 1400,
    availableQuantity: 500,
    standardDeliveryDays: 5,
    maxDeliveryDays: 12,
    negotiable: true,
  },
  {
    sku: "LAPTOP-14-I5",
    name: "14-inch Business Laptop (i5, 16GB RAM)",
    description: "Mid-range business laptop suitable for office use.",
    listedPrice: 48000,
    availableQuantity: 10,
    standardDeliveryDays: 5,
    maxDeliveryDays: 12,
    negotiable: true,
  },
];

describe("parseBuyerIntent", () => {
  // 1. Normal successful request.
  it("parses a normal, fully-specified request into a resolved BuyerIntent", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      JSON.stringify({
        sku: "KEYBOARD-WIRELESS",
        quantity: 300,
        targetPrice: 1200,
        maxPrice: 1270,
        deliveryDeadlineDays: 5,
        urgency: "high",
        deliveryFlexible: false,
        budgetFlexible: false,
      }),
    );

    const result = await parseBuyerIntent(
      "I need 300 wireless keyboard and mouse combos for our office. I need them within 5 days. I'd like to stay around ₹1,200 each, but I can pay a little more if I can get faster delivery.",
      catalog,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.intent).toEqual({
      sku: "KEYBOARD-WIRELESS",
      productName: "Wireless Keyboard & Mouse Combo",
      quantity: 300,
      targetPrice: 1200,
      maxPrice: 1270,
      deliveryDeadlineDays: 5,
      urgency: "high",
      deliveryFlexible: false,
      budgetFlexible: false,
    });
  });

  // 2. High urgency.
  it("carries a genuinely stated high urgency through, distinct from the medium default", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      JSON.stringify({
        sku: "LAPTOP-14-I5",
        quantity: 5,
        targetPrice: null,
        maxPrice: 49000,
        deliveryDeadlineDays: 2,
        urgency: "high",
        deliveryFlexible: false,
      }),
    );

    const result = await parseBuyerIntent("I urgently need 5 laptops within 2 days, up to 49000 each.", catalog);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.intent.urgency).toBe("high");
    expect(result.intent.targetPrice).toBeUndefined();
  });

  // 3. Flexible delivery.
  it("carries a genuinely stated delivery flexibility through, distinct from the false default", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      JSON.stringify({
        sku: "LAPTOP-14-I5",
        quantity: 6,
        targetPrice: 43700,
        maxPrice: 46000,
        deliveryDeadlineDays: 7,
        urgency: "medium",
        deliveryFlexible: true,
      }),
    );

    const result = await parseBuyerIntent(
      "I'd like 6 laptops, around 43700 each up to 46000, and I can wait a bit longer than 7 days for a better price.",
      catalog,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.intent.deliveryFlexible).toBe(true);
  });

  // 4. Missing maximum budget.
  it("reports maxPrice as missing, without inventing one, when the model could not determine it", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      JSON.stringify({
        sku: "KEYBOARD-WIRELESS",
        quantity: 300,
        targetPrice: null,
        maxPrice: null,
        deliveryDeadlineDays: 5,
        urgency: "high",
        deliveryFlexible: false,
      }),
    );

    const result = await parseBuyerIntent(
      "I need 300 wireless keyboard and mouse combos within 5 days, quite urgently.",
      catalog,
    );

    expect(result.status).toBe("missing_fields");
    if (result.status !== "missing_fields") throw new Error("expected missing_fields");
    expect(result.missingFields).toEqual(["maxPrice"]);
    expect(result.understood.maxPrice).toBeUndefined();
    // Everything else the model DID determine is preserved, not discarded.
    expect(result.understood.sku).toBe("KEYBOARD-WIRELESS");
    expect(result.understood.quantity).toBe(300);
    expect(result.understood.deliveryDeadlineDays).toBe(5);
    expect(result.message).toMatch(/maximum budget/i);
  });

  // 5. Unknown/non-catalog product.
  it("never invents a product — an unmatched product name is reported, not guessed at", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      JSON.stringify({
        sku: "OFFICE-CHAIR-DELUXE",
        quantity: 10,
        targetPrice: null,
        maxPrice: 5000,
        deliveryDeadlineDays: 7,
        urgency: "medium",
        deliveryFlexible: false,
      }),
    );

    const result = await parseBuyerIntent("I need 10 office chairs, up to 5000 each, within 7 days.", catalog);

    expect(result.status).toBe("unknown_product");
    if (result.status !== "unknown_product") throw new Error("expected unknown_product");
    expect(result.message).toContain("Wireless Keyboard & Mouse Combo");
    expect(result.message).toContain("14-inch Business Laptop (i5, 16GB RAM)");
    // Fields other than the product are still preserved for the fallback form.
    expect(result.understood.quantity).toBe(10);
    expect(result.understood.maxPrice).toBe(5000);
  });

  // 6. Malformed/unusable LLM output.
  it("reports unparseable when the model's output isn't valid JSON at all", async () => {
    mockedGenerateAgentMessage.mockResolvedValue("Sure! I can help you with that purchase.");

    const result = await parseBuyerIntent("I need some laptops.", catalog);

    expect(result.status).toBe("unparseable");
  });

  it("still parses JSON wrapped in a markdown code fence", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      "```json\n" +
        JSON.stringify({
          sku: "LAPTOP-14-I5",
          quantity: 3,
          targetPrice: null,
          maxPrice: 49500,
          deliveryDeadlineDays: 2,
          urgency: "high",
          deliveryFlexible: false,
        }) +
        "\n```",
    );

    const result = await parseBuyerIntent("3 laptops, rush, up to 49500, within 2 days.", catalog);

    expect(result.status).toBe("ok");
  });

  it("reports unparseable (rather than throwing) when the LLM provider is unavailable", async () => {
    mockedGenerateAgentMessage.mockRejectedValue(new LlmUnavailableError("no key configured"));

    const result = await parseBuyerIntent("I need 10 laptops.", catalog);

    expect(result.status).toBe("unparseable");
  });

  it("rejects an empty/whitespace-only message without ever calling the LLM", async () => {
    const result = await parseBuyerIntent("   ", catalog);

    expect(result.status).toBe("unparseable");
    expect(mockedGenerateAgentMessage).not.toHaveBeenCalled();
  });

  // Pass 4: budgetFlexible extraction.
  it("carries a genuinely stated budget flexibility through, distinct from the false default", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      JSON.stringify({
        sku: "LAPTOP-14-I5",
        quantity: 5,
        targetPrice: null,
        maxPrice: 50000,
        deliveryDeadlineDays: 10,
        urgency: "medium",
        deliveryFlexible: false,
        budgetFlexible: true,
      }),
    );

    const result = await parseBuyerIntent(
      "I'd prefer to stay around ₹50,000 for 5 laptops, within 10 days, but my budget is flexible.",
      catalog,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.intent.budgetFlexible).toBe(true);
    // The stated number is still extracted normally — flexibility never
    // causes maxPrice to be omitted or invented.
    expect(result.intent.maxPrice).toBe(50000);
  });

  it("defaults budgetFlexible to false for a plainly stated hard maximum", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      JSON.stringify({
        sku: "LAPTOP-14-I5",
        quantity: 5,
        targetPrice: null,
        maxPrice: 50000,
        deliveryDeadlineDays: 10,
        urgency: "medium",
        deliveryFlexible: false,
        budgetFlexible: false,
      }),
    );

    const result = await parseBuyerIntent(
      "I don't want to spend more than ₹50,000 on 5 laptops, within 10 days.",
      catalog,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.intent.budgetFlexible).toBe(false);
  });

  it("defaults urgency to medium and deliveryFlexible to false when genuinely unstated — never fabricating a stronger preference", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      JSON.stringify({
        sku: "LAPTOP-14-I5",
        quantity: 4,
        targetPrice: null,
        maxPrice: 47000,
        deliveryDeadlineDays: 10,
        urgency: null,
        deliveryFlexible: null,
      }),
    );

    const result = await parseBuyerIntent("4 laptops, up to 47000, within 10 days.", catalog);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.intent.urgency).toBe("medium");
    expect(result.intent.deliveryFlexible).toBe(false);
  });
});

// Pass 6: resolving the single-price + stretch-language ambiguity, where
// the model sometimes files the buyer's one stated number as targetPrice
// and leaves maxPrice null even though the buyer effectively stated a
// (flexible) ceiling.
describe("parseBuyerIntent — Pass 6: single-price + stretch language", () => {
  // A. Single price + stretch language: the model returns exactly what a
  // real Gemini call was observed to return for "45k is my target but I
  // can stretch a little" (targetPrice set, maxPrice null, budgetFlexible
  // true) — the deterministic post-processing must recover maxPrice from
  // targetPrice rather than reporting it missing.
  it("recovers maxPrice from targetPrice when budgetFlexible is true and only one number was given", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      JSON.stringify({
        sku: "LAPTOP-14-I5",
        quantity: 5,
        targetPrice: 45000,
        maxPrice: null,
        deliveryDeadlineDays: 10,
        urgency: "medium",
        deliveryFlexible: false,
        budgetFlexible: true,
      }),
    );

    const result = await parseBuyerIntent(
      "5 laptops within 10 days, 45k is my target but I can stretch a little.",
      catalog,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.intent.maxPrice).toBe(45000);
    expect(result.intent.targetPrice).toBeUndefined();
    expect(result.intent.budgetFlexible).toBe(true);
  });

  it("also recovers maxPrice for 'could go higher' phrasing, same shape", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      JSON.stringify({
        sku: "LAPTOP-14-I5",
        quantity: 5,
        targetPrice: 45000,
        maxPrice: null,
        deliveryDeadlineDays: 10,
        urgency: "medium",
        deliveryFlexible: false,
        budgetFlexible: true,
      }),
    );

    const result = await parseBuyerIntent(
      "5 laptops within 10 days, 45k is my target but I could go higher if I have to.",
      catalog,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.intent.maxPrice).toBe(45000);
    expect(result.intent.targetPrice).toBeUndefined();
  });

  // B. A genuine two-number statement (separate target AND a higher max)
  // must be completely untouched by the recovery logic — both fields
  // stay exactly as the model reported them.
  it("preserves a genuine separate target and maximum when both are given", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      JSON.stringify({
        sku: "LAPTOP-14-I5",
        quantity: 5,
        targetPrice: 40000,
        maxPrice: 45000,
        deliveryDeadlineDays: 10,
        urgency: "medium",
        deliveryFlexible: false,
        budgetFlexible: true,
      }),
    );

    const result = await parseBuyerIntent(
      "5 laptops within 10 days, target 40k, but I can go up to 45k.",
      catalog,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.intent.targetPrice).toBe(40000);
    expect(result.intent.maxPrice).toBe(45000);
  });

  // C. Hard-budget language (no flexibility signaled) — a single number
  // reported directly as maxPrice is untouched (nothing to recover).
  it("leaves a plainly-stated hard maximum untouched", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      JSON.stringify({
        sku: "LAPTOP-14-I5",
        quantity: 5,
        targetPrice: null,
        maxPrice: 45000,
        deliveryDeadlineDays: 10,
        urgency: "medium",
        deliveryFlexible: false,
        budgetFlexible: false,
      }),
    );

    const result = await parseBuyerIntent("5 laptops within 10 days, 45k max, don't exceed it.", catalog);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.intent.maxPrice).toBe(45000);
    expect(result.intent.targetPrice).toBeUndefined();
    expect(result.intent.budgetFlexible).toBe(false);
  });

  // The recovery must NEVER fire when budgetFlexible is false — a lone
  // targetPrice with no stated ceiling and no flexibility signal is a
  // genuine "still need your maximum budget" case, not this ambiguity.
  it("does NOT recover maxPrice from targetPrice when budgetFlexible is false — still reports maxPrice missing", async () => {
    mockedGenerateAgentMessage.mockResolvedValue(
      JSON.stringify({
        sku: "LAPTOP-14-I5",
        quantity: 5,
        targetPrice: 45000,
        maxPrice: null,
        deliveryDeadlineDays: 10,
        urgency: "medium",
        deliveryFlexible: false,
        budgetFlexible: false,
      }),
    );

    const result = await parseBuyerIntent(
      "5 laptops within 10 days, I'm hoping for around 45k.",
      catalog,
    );

    expect(result.status).toBe("missing_fields");
    if (result.status !== "missing_fields") throw new Error("expected missing_fields");
    expect(result.missingFields).toEqual(["maxPrice"]);
    expect(result.understood.maxPrice).toBeUndefined();
    expect(result.understood.targetPrice).toBe(45000);
  });
});

// 7. The resulting structured intent maps correctly onto the existing
// negotiation request shape (NegotiationSessionCreateRequest) — the
// same request the existing structured form already sends to the
// existing, unmodified POST /api/negotiations.
describe("buyerIntentToSessionRequest", () => {
  it("maps every BuyerIntent field onto its NegotiationSessionCreateRequest counterpart", () => {
    const request = buyerIntentToSessionRequest({
      sku: "KEYBOARD-WIRELESS",
      productName: "Wireless Keyboard & Mouse Combo",
      quantity: 300,
      targetPrice: 1200,
      maxPrice: 1270,
      deliveryDeadlineDays: 5,
      urgency: "high",
      deliveryFlexible: false,
      budgetFlexible: false,
    });

    expect(request).toEqual({
      sku: "KEYBOARD-WIRELESS",
      quantity: 300,
      maxUnitPrice: 1270,
      deliveryDeadlineDays: 5,
      urgency: "high",
      deliveryFlexible: false,
      targetUnitPrice: 1200,
      budgetFlexible: false,
    });
  });

  it("omits targetUnitPrice (rather than sending null/0) when no targetPrice was understood", () => {
    const request = buyerIntentToSessionRequest({
      sku: "LAPTOP-14-I5",
      productName: "14-inch Business Laptop (i5, 16GB RAM)",
      quantity: 5,
      maxPrice: 49000,
      deliveryDeadlineDays: 2,
      urgency: "high",
      deliveryFlexible: false,
      budgetFlexible: false,
    });

    expect(request.targetUnitPrice).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain("targetUnitPrice");
  });

  // Pass 4: budgetFlexible maps straight through, mirroring deliveryFlexible.
  it("maps budgetFlexible: true through unchanged", () => {
    const request = buyerIntentToSessionRequest({
      sku: "LAPTOP-14-I5",
      productName: "14-inch Business Laptop (i5, 16GB RAM)",
      quantity: 5,
      maxPrice: 50000,
      deliveryDeadlineDays: 10,
      urgency: "medium",
      deliveryFlexible: false,
      budgetFlexible: true,
    });

    expect(request.budgetFlexible).toBe(true);
  });
});
