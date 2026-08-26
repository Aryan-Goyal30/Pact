import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import type { PublicManifestProduct } from "@/types/manifest";
import { createNegotiationState } from "@/lib/rules/negotiationState";
import {
  runNegotiationToCompletion,
  runNegotiationTurn,
  type NegotiationContext,
} from "./orchestrator";
import { getLlmProvider } from "@/lib/llm/provider";

// The LLM is mocked at the provider boundary — every other layer (buyer
// agent, merchant agent, deterministic engine, state machine) runs for
// real, so these tests genuinely exercise the orchestrator wiring, not
// a stub of it. Message text content is irrelevant to these tests, so a
// single fixed string is enough. LlmUnavailableError is kept real (via
// importOriginal) since buyerAgent.ts/merchantAgent.ts's `instanceof`
// checks against it must keep working even when this module is mocked.
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

const demoBuyerConstraints: BuyerConstraints = {
  sku: "LAPTOP-14-I5",
  quantity: 200,
  maxUnitPrice: 45000,
  deliveryDeadlineDays: 10,
};

function demoContext(): NegotiationContext {
  return {
    item: laptop,
    manifestProduct: laptopManifestListing,
    buyerConstraints: demoBuyerConstraints,
  };
}

// 9. The orchestrator can execute at least one complete buyer -> merchant turn.
describe("runNegotiationTurn", () => {
  it("executes one full buyer -> merchant exchange and returns structured messages for both", async () => {
    const state = createNegotiationState(4);
    const turn = await runNegotiationTurn(demoContext(), state, null);

    expect(turn.buyer.sender).toBe("buyer");
    expect(turn.merchant.sender).toBe("merchant");
    expect(turn.buyer.sku).toBe("LAPTOP-14-I5");
    expect(turn.merchant.sku).toBe("LAPTOP-14-I5");
  });

  // 4. Structured negotiation messages contain authoritative fields.
  it("populates structured fields straight from the deterministic engine, regardless of the mocked message text", async () => {
    const state = createNegotiationState(4);
    const turn = await runNegotiationTurn(demoContext(), state, null);

    // Round 1 of the demo scenario: buyer asks for 200, merchant can
    // only supply 100 — this is the deterministic PARTIAL_FULFILLMENT
    // counter computed by evaluateNegotiationRequest/computeCounterOfferPrice.
    expect(turn.merchant.type).toBe("counter_offer");
    expect(turn.merchant.quantity).toBe(100);
    expect(turn.merchant.unitPrice).toBe(46500);
    expect(turn.merchant.deliveryDays).toBe(5);
    expect(turn.merchant.message).toBe("mocked agent message");
  });

  // 8. Terminal negotiation state cannot continue.
  it("refuses to run another turn once the state is terminal", async () => {
    const terminalState = { status: "AGREED" as const, round: 1, maxRounds: 4 };
    await expect(runNegotiationTurn(demoContext(), terminalState, null)).rejects.toThrow(
      /already terminal/i,
    );
  });
});

describe("runNegotiationToCompletion — demo scenario (200 laptops requested, 100 available)", () => {
  it("converges to AGREED within the round limit without ever violating merchant constraints", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion(demoContext(), 4);

    expect(finalState.status).toBe("AGREED");
    expect(transcript.length).toBeGreaterThan(0);
    expect(transcript.length).toBeLessThanOrEqual(4);

    for (const turn of transcript) {
      // 5. Merchant rules remain authoritative — never violated at any turn.
      if (turn.merchant.quantity !== null) {
        expect(turn.merchant.quantity).toBeLessThanOrEqual(laptop.availableQty);
        expect(turn.merchant.quantity).toBeGreaterThan(0);
      }
      if (turn.merchant.unitPrice !== null) {
        expect(turn.merchant.unitPrice).toBeGreaterThanOrEqual(laptop.minPrice);
        expect(turn.merchant.unitPrice).toBeLessThanOrEqual(laptop.listedPrice);
      }
      if (turn.merchant.deliveryDays !== null) {
        expect(turn.merchant.deliveryDays).toBeLessThanOrEqual(laptop.maxDeliveryDays);
      }
    }

    const lastTurn = transcript[transcript.length - 1];
    expect(lastTurn.merchant.type).toBe("accept");
    // Never more than available, never below the private floor.
    expect(lastTurn.merchant.quantity).toBeLessThanOrEqual(100);
    expect(lastTurn.merchant.unitPrice).toBeGreaterThanOrEqual(44000);
    // Never a delivery promise the merchant can't keep or the buyer didn't ask for.
    expect(lastTurn.merchant.deliveryDays).toBeLessThanOrEqual(10);
  });

  it("never leaks the private floor into any structured message or buyer-visible text", async () => {
    const { transcript } = await runNegotiationToCompletion(demoContext(), 4);

    for (const turn of transcript) {
      expect(JSON.stringify(turn.buyer)).not.toContain("44000");
    }
  });

  // 1, 3, 6. Correction: the merchant must not cave to 45000 the first
  // time it's technically above the floor — it should gradually concede
  // (round 2), only settling once it has no better valid counter left
  // to make (round 3), with the buyer then explicitly accepting
  // (round 4). This pins the exact turn-by-turn trace so a regression
  // back to "accept as soon as it clears the floor" would fail loudly.
  it("gradually concedes across rounds instead of accepting 45000 the first time it clears the floor", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion(demoContext(), 4);

    expect(transcript.map((t) => t.merchant.type)).toEqual([
      "counter_offer",
      "counter_offer",
      "counter_offer",
      "accept",
    ]);
    expect(transcript.map((t) => t.merchant.unitPrice)).toEqual([46500, 45750, 45000, 45000]);
    // Every merchant counter strictly decreases toward (never below) the
    // buyer's ceiling — genuine gradual concession, not a static repeat.
    expect(transcript[1].merchant.unitPrice!).toBeLessThan(transcript[0].merchant.unitPrice!);
    expect(transcript[2].merchant.unitPrice!).toBeLessThan(transcript[1].merchant.unitPrice!);
    // 5. The buyer never proposes or accepts above its own ceiling, on any turn.
    for (const turn of transcript) {
      if (turn.buyer.unitPrice !== null) {
        expect(turn.buyer.unitPrice).toBeLessThanOrEqual(demoBuyerConstraints.maxUnitPrice);
      }
    }
    expect(finalState.status).toBe("AGREED");
  });
});

// 7. A second product scenario, proving the concession strategy is
// general rather than tuned to the laptop's specific numbers.
describe("runNegotiationToCompletion — a different product (monitor)", () => {
  const monitor: CatalogItemSnapshot = {
    sku: "MONITOR-24-FHD",
    listedPrice: 9500,
    minPrice: 8200,
    availableQty: 250,
    standardDeliveryDays: 4,
    maxDeliveryDays: 10,
    negotiationEnabled: true,
  };

  const monitorManifestListing: PublicManifestProduct = {
    sku: "MONITOR-24-FHD",
    name: "24-inch Full HD Monitor",
    description: "Standard office monitor, 1920x1080.",
    listedPrice: 9500,
    availableQuantity: 250,
    standardDeliveryDays: 4,
    maxDeliveryDays: 10,
    negotiable: true,
  };

  it("converges without ever violating this product's own floor, stock, or delivery constraints", async () => {
    const context: NegotiationContext = {
      item: monitor,
      manifestProduct: monitorManifestListing,
      buyerConstraints: {
        sku: "MONITOR-24-FHD",
        quantity: 50,
        maxUnitPrice: 8800,
        deliveryDeadlineDays: 8,
      },
    };

    const { transcript, finalState } = await runNegotiationToCompletion(context, 4);

    expect(finalState.status).toBe("AGREED");
    for (const turn of transcript) {
      if (turn.merchant.unitPrice !== null) {
        expect(turn.merchant.unitPrice).toBeGreaterThanOrEqual(monitor.minPrice);
        expect(turn.merchant.unitPrice).toBeLessThanOrEqual(monitor.listedPrice);
      }
      if (turn.merchant.quantity !== null) {
        expect(turn.merchant.quantity).toBeLessThanOrEqual(monitor.availableQty);
      }
      if (turn.buyer.unitPrice !== null) {
        expect(turn.buyer.unitPrice).toBeLessThanOrEqual(8800);
      }
    }
    // Same qualitative shape as the laptop demo: gradual concession, not
    // an instant accept — proving the strategy isn't laptop-specific.
    expect(transcript[0].merchant.type).toBe("counter_offer");
    expect(transcript[0].merchant.unitPrice).not.toBe(8800);
  });
});

// 7. Negotiation round count remains bounded.
describe("runNegotiationToCompletion — bounded rounds when no agreement is possible", () => {
  it("terminates as EXPIRED, never looping past the configured round limit", async () => {
    // Buyer's ceiling (₹30,000) is below the merchant's private floor
    // (₹44,000) — no deterministic path to agreement exists, so this
    // should run out its rounds and stop rather than loop forever.
    const context: NegotiationContext = {
      item: laptop,
      manifestProduct: laptopManifestListing,
      buyerConstraints: {
        sku: "LAPTOP-14-I5",
        quantity: 10,
        maxUnitPrice: 30000,
        deliveryDeadlineDays: 10,
      },
    };

    const { transcript, finalState } = await runNegotiationToCompletion(context, 2);

    expect(finalState.status).toBe("EXPIRED");
    // 2 COUNTERED rounds + 1 final EXPIRED attempt.
    expect(transcript.length).toBe(3);
    expect(transcript[transcript.length - 1].state.status).toBe("EXPIRED");
  });
});
