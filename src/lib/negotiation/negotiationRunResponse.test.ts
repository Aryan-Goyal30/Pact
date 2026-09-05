import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import type { PublicManifestProduct } from "@/types/manifest";
import { runNegotiationToCompletion, type NegotiationContext } from "./orchestrator";
import { buildNegotiationRunResponse } from "./negotiationRunResponse";
import { getLlmProvider } from "@/lib/llm/provider";

vi.mock("@/lib/llm/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/provider")>();
  return {
    ...actual,
    getLlmProvider: vi.fn(),
  };
});

const mockedGetLlmProvider = vi.mocked(getLlmProvider);

beforeEach(() => {
  mockedGetLlmProvider.mockReturnValue({
    generateAgentMessage: vi.fn().mockResolvedValue("mocked agent message"),
  });
});

// Mirrors the real seeded LAPTOP-14-I5 catalog item (prisma/seed.ts).
const laptop: CatalogItemSnapshot = {
  sku: "LAPTOP-14-I5",
  listedPrice: 48000,
  minPrice: 44000,
  availableQty: 100,
  standardDeliveryDays: 5,
  maxDeliveryDays: 12,
  negotiationEnabled: true,
};

const laptopManifestListing: PublicManifestProduct = {
  sku: "LAPTOP-14-I5",
  name: "14-inch Business Laptop (i5, 16GB RAM)",
  description: "Mid-range business laptop suitable for office use.",
  listedPrice: 48000,
  availableQuantity: 100,
  standardDeliveryDays: 5,
  maxDeliveryDays: 12,
  negotiable: true,
};

const buyerConstraints: BuyerConstraints = {
  sku: "LAPTOP-14-I5",
  quantity: 200,
  maxUnitPrice: 45000,
  deliveryDeadlineDays: 10,
};

describe("buildNegotiationRunResponse", () => {
  it("shapes a completed AGREED run into turns and a computed agreement", async () => {
    const context: NegotiationContext = {
      item: laptop,
      manifestProduct: laptopManifestListing,
      buyerConstraints,
    };
    const { transcript, finalState } = await runNegotiationToCompletion(context, 4);

    const response = buildNegotiationRunResponse("LAPTOP-14-I5", transcript, finalState);

    expect(response.sku).toBe("LAPTOP-14-I5");
    expect(response.finalStatus).toBe("AGREED");
    expect(response.transcript).toHaveLength(transcript.length);
    expect(response.transcript[0].turn).toBe(1);
    expect(response.transcript.every((t) => t.buyer.sender === "buyer")).toBe(true);
    expect(response.transcript.every((t) => t.merchant.sender === "merchant")).toBe(true);

    expect(response.agreement).not.toBeNull();
    expect(response.agreement!.quantity).toBeLessThanOrEqual(100);
    expect(response.agreement!.unitPrice).toBeGreaterThanOrEqual(44000);
    expect(response.agreement!.totalAmount).toBe(
      response.agreement!.quantity * response.agreement!.unitPrice,
    );
  });

  // Scenario-behavior fix: a deadline faster than standard is no longer
  // impossible on its own — the merchant can expedite for a price
  // premium. A non-positive deadline remains genuinely nonsensical
  // regardless of price, so it's what this test uses to reliably reach
  // REJECTED with no negotiation at all.
  it("returns a null agreement for a run that ends REJECTED or EXPIRED", async () => {
    const context: NegotiationContext = {
      item: laptop,
      manifestProduct: laptopManifestListing,
      buyerConstraints: {
        sku: "LAPTOP-14-I5",
        quantity: 10,
        maxUnitPrice: 45000,
        deliveryDeadlineDays: 0, // not a valid delivery window
      },
    };
    const { transcript, finalState } = await runNegotiationToCompletion(context, 4);

    const response = buildNegotiationRunResponse("LAPTOP-14-I5", transcript, finalState);

    expect(response.finalStatus).toBe("REJECTED");
    expect(response.agreement).toBeNull();
  });

  // Most important: the browser/API response must never contain minPrice.
  it("never contains minPrice, or the merchant's private floor value, anywhere in the response", async () => {
    const context: NegotiationContext = {
      item: laptop,
      manifestProduct: laptopManifestListing,
      buyerConstraints,
    };
    const { transcript, finalState } = await runNegotiationToCompletion(context, 4);

    const response = buildNegotiationRunResponse("LAPTOP-14-I5", transcript, finalState);
    const serialized = JSON.stringify(response);

    expect(serialized).not.toContain("minPrice");
    expect(serialized).not.toContain(String(laptop.minPrice)); // "44000"
  });
});
