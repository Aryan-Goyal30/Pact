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
    // Overrides the describe-level default mock for this test only: that
    // default ("mocked agent message") carries no numbers at all, so
    // messageIntegrity.ts's required-number check would reject it for
    // the merchant's counter-offer (which must state quantity/price/
    // delivery) and silently substitute the deterministic fallback —
    // this test needs to see its own literal mocked text come through,
    // so its mock states the round's real numbers instead.
    const roundOneMerchantMessage = "mocked agent message covering 100 units at 45375 per unit for 5 days";
    mockedGetLlmProvider.mockReturnValue({
      generateAgentMessage: vi.fn().mockResolvedValue(roundOneMerchantMessage),
    });

    const state = createNegotiationState(4);
    const turn = await runNegotiationTurn(demoContext(), state, null);

    // Round 1 of the demo scenario: buyer opens near its target (not its
    // maxUnitPrice — see buyerRules.resolveBuyerTarget) at 200 units;
    // merchant can only supply 100 — this is the deterministic
    // PARTIAL_FULFILLMENT counter computed by
    // evaluateNegotiationRequest + computeMerchantConcessionPrice.
    expect(turn.buyer.unitPrice).toBe(42750); // round(45000 * 0.95)
    expect(turn.merchant.type).toBe("counter_offer");
    expect(turn.merchant.quantity).toBe(100);
    expect(turn.merchant.unitPrice).toBe(45375);
    expect(turn.merchant.deliveryDays).toBe(5);
    expect(turn.merchant.message).toBe(roundOneMerchantMessage);
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

  // 1, 3, 6. Phase 5B: both sides genuinely move. The buyer opens near
  // its target (not its ceiling), the merchant concedes gradually from
  // its listed price, and the buyer accepts as soon as a merchant offer
  // actually clears its own ceiling — not at some earlier hard-coded
  // number. This pins the exact turn-by-turn trace so a regression back
  // to either side's old rigid behavior fails loudly.
  it("has both sides genuinely move — buyer opens below its ceiling, merchant concedes gradually, buyer accepts once satisfied", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion(demoContext(), 4);

    // Buyer: target (42750) on the opening ask, then a progressive
    // counter, never touching its true ceiling (45000) until it has to.
    expect(transcript.map((t) => t.buyer.unitPrice)).toEqual([42750, 44063, 44719]);
    // Merchant: gradual concession from its listed-price anchor, closing
    // the moment the buyer's own ceiling is actually met.
    expect(transcript.map((t) => t.merchant.type)).toEqual([
      "counter_offer",
      "counter_offer",
      "accept",
    ]);
    expect(transcript.map((t) => t.merchant.unitPrice)).toEqual([45375, 44719, 44719]);

    // Every merchant counter strictly decreases — genuine gradual
    // concession, not a static repeat.
    expect(transcript[1].merchant.unitPrice!).toBeLessThan(transcript[0].merchant.unitPrice!);
    // The buyer never proposes or accepts above its own ceiling on any turn.
    for (const turn of transcript) {
      if (turn.buyer.unitPrice !== null) {
        expect(turn.buyer.unitPrice).toBeLessThanOrEqual(demoBuyerConstraints.maxUnitPrice);
      }
    }
    // The agreed price sits strictly between the merchant's private
    // floor (44000, never itself asserted equal here) and the buyer's
    // ceiling (45000) — a genuine negotiated middle ground, not either
    // side's opening number.
    expect(finalState.status).toBe("AGREED");
    const agreedPrice = transcript[transcript.length - 1].merchant.unitPrice!;
    expect(agreedPrice).toBeGreaterThan(44000);
    expect(agreedPrice).toBeLessThan(45000);
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

// 11. Agents can walk away when constraints cannot be satisfied, even
// with the new strategic factors (urgency, quantity leverage) active —
// they can shift *where* the merchant/buyer land, never *whether* the
// floor/ceiling constraints are honored.
describe("runNegotiationToCompletion — walk away with strategic factors active", () => {
  it("still EXPIREs when the buyer's ceiling is below the floor, even with high urgency and a large order", async () => {
    const context: NegotiationContext = {
      item: laptop, // floor 44000
      manifestProduct: laptopManifestListing,
      buyerConstraints: {
        sku: "LAPTOP-14-I5",
        quantity: 500, // crosses the large-order leverage threshold
        maxUnitPrice: 30000, // below the floor — no deal is possible
        deliveryDeadlineDays: 10,
        urgency: "high",
      },
    };

    const { transcript, finalState } = await runNegotiationToCompletion(context, 2);

    expect(finalState.status).toBe("EXPIRED");
    for (const turn of transcript) {
      // The floor is never breached, no matter how the strategic factors shift the number.
      if (turn.merchant.unitPrice !== null) {
        expect(turn.merchant.unitPrice).toBeGreaterThanOrEqual(44000);
      }
      // The buyer's high urgency never pushes it past its own hard ceiling.
      if (turn.buyer.unitPrice !== null) {
        expect(turn.buyer.unitPrice).toBeLessThanOrEqual(30000);
      }
    }
  });
});

// Section 11's named demo scenarios, each as its own dedicated test.
describe("Section 11 demo scenarios", () => {
  // A. Buyer maximum below merchant floor -> no agreement, ever, at any price.
  it("A: never agrees when the buyer's ceiling is below the merchant's private floor", async () => {
    const context: NegotiationContext = {
      item: laptop, // floor 44000
      manifestProduct: laptopManifestListing,
      buyerConstraints: {
        sku: "LAPTOP-14-I5",
        quantity: 10,
        maxUnitPrice: 42000, // below the 44000 floor
        deliveryDeadlineDays: 10,
      },
    };

    const { transcript, finalState } = await runNegotiationToCompletion(context, 4);

    expect(finalState.status).not.toBe("AGREED");
    expect(["REJECTED", "EXPIRED"]).toContain(finalState.status);
    for (const turn of transcript) {
      if (turn.merchant.unitPrice !== null) {
        expect(turn.merchant.unitPrice).toBeGreaterThanOrEqual(44000);
      }
      // The buyer never breaks its own ceiling to force a deal through.
      if (turn.buyer.unitPrice !== null) {
        expect(turn.buyer.unitPrice).toBeLessThanOrEqual(42000);
      }
    }
  });

  // C. High buyer ceiling -> merchant must not charge above listed price
  // just because the buyer could afford more.
  it("C: never charges above listed price even when the buyer's ceiling is far higher", async () => {
    const context: NegotiationContext = {
      item: laptop, // listed 48000
      manifestProduct: laptopManifestListing,
      buyerConstraints: {
        sku: "LAPTOP-14-I5",
        quantity: 10,
        maxUnitPrice: 90000, // far above listed price
        deliveryDeadlineDays: 10,
      },
    };

    const { transcript, finalState } = await runNegotiationToCompletion(context, 4);

    expect(finalState.status).toBe("AGREED");
    for (const turn of transcript) {
      if (turn.merchant.unitPrice !== null) {
        expect(turn.merchant.unitPrice).toBeLessThanOrEqual(48000);
      }
    }
    const agreement = transcript[transcript.length - 1];
    expect(agreement.merchant.unitPrice).toBe(48000);
    // The merchant closes this immediately by explicitly accepting —
    // there's nothing left to negotiate once the buyer's ask already
    // clears the listed price.
    expect(agreement.merchant.type).toBe("accept");
    expect(transcript.length).toBe(1);
  });

  // D. Impossible delivery -> rejected deterministically, no negotiation.
  it("D: rejects deterministically when the buyer's delivery deadline is impossible", async () => {
    const context: NegotiationContext = {
      item: laptop, // standard delivery 5 days
      manifestProduct: laptopManifestListing,
      buyerConstraints: {
        sku: "LAPTOP-14-I5",
        quantity: 10,
        maxUnitPrice: 45000,
        deliveryDeadlineDays: 1, // faster than the merchant can ever do
      },
    };

    const { transcript, finalState } = await runNegotiationToCompletion(context, 4);

    expect(finalState.status).toBe("REJECTED");
    expect(transcript).toHaveLength(1);
    expect(transcript[0].merchant.type).toBe("reject");
  });

  // F. Non-negotiable product -> existing Phase 3 rules still apply: only
  // the exact listed terms are fulfillable, no counters.
  it("F: a non-negotiable item only ever fulfills the exact listed terms", async () => {
    const nonNegotiable: CatalogItemSnapshot = { ...laptop, negotiationEnabled: false };
    const nonNegotiableListing: PublicManifestProduct = {
      ...laptopManifestListing,
      negotiable: false,
    };

    // A request within stock at listed price and standard delivery: fine.
    const exact = await runNegotiationToCompletion(
      {
        item: nonNegotiable,
        manifestProduct: nonNegotiableListing,
        buyerConstraints: {
          sku: "LAPTOP-14-I5",
          quantity: 10,
          maxUnitPrice: 48000,
          deliveryDeadlineDays: 5,
        },
      },
      4,
    );
    expect(exact.finalState.status).toBe("AGREED");
    expect(exact.transcript[exact.transcript.length - 1].merchant.unitPrice).toBe(48000);

    // Any request for a discount is rejected outright — no counter-offer.
    const discounted = await runNegotiationToCompletion(
      {
        item: nonNegotiable,
        manifestProduct: nonNegotiableListing,
        buyerConstraints: {
          sku: "LAPTOP-14-I5",
          quantity: 10,
          maxUnitPrice: 45000,
          deliveryDeadlineDays: 5,
        },
      },
      4,
    );
    expect(discounted.finalState.status).toBe("REJECTED");
    expect(discounted.transcript.every((t) => t.merchant.type !== "counter_offer")).toBe(true);
  });
});

// Leverage-visualization + detailed-scenarios milestone: every turn now
// carries a live leverage score (leverage.ts), and the public API/UI
// finally expose urgency + deliveryFlexible — this section proves the
// underlying deterministic math (already wired up by the strategy
// hardening milestone) behaves coherently for realistic combinations of
// those factors, end to end through the real orchestrator, not just in
// isolated unit tests.
describe("combined strategic factors (item J scenarios)", () => {
  const wellStocked: CatalogItemSnapshot = {
    sku: "MONITOR-24-FHD",
    listedPrice: 9500,
    minPrice: 8200,
    availableQty: 1000,
    standardDeliveryDays: 4,
    maxDeliveryDays: 12,
    negotiationEnabled: true,
  };
  const wellStockedListing: PublicManifestProduct = {
    sku: "MONITOR-24-FHD",
    name: "24-inch Full HD Monitor",
    description: "Standard office monitor, 1920x1080.",
    listedPrice: 9500,
    availableQuantity: 1000,
    standardDeliveryDays: 4,
    maxDeliveryDays: 12,
    negotiable: true,
  };

  // large quantity + high merchant stock -> strong buyer leverage.
  it("large quantity against ample stock: buyer leverage is high and the price moves well below listed", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion(
      {
        item: wellStocked,
        manifestProduct: wellStockedListing,
        buyerConstraints: { sku: "MONITOR-24-FHD", quantity: 400, maxUnitPrice: 9200, deliveryDeadlineDays: 6 },
      },
      6,
    );
    expect(finalState.status).not.toBe("REJECTED"); // a well-stocked, achievable request should never be rejected outright
    const lastTurn = transcript[transcript.length - 1];
    expect(lastTurn.leverage.buyerLeverage).toBeGreaterThan(50);
    // Never below the merchant's floor no matter how buyer-favoring leverage gets.
    for (const turn of transcript) {
      if (turn.merchant.unitPrice !== null) {
        expect(turn.merchant.unitPrice).toBeGreaterThanOrEqual(wellStocked.minPrice);
      }
    }
  });

  // large quantity + low merchant stock -> the physical constraint
  // dominates: quantity is clamped (partial fulfillment remains valid),
  // and leverage favors the merchant despite the large ask.
  it("large quantity against tight stock: quantity is clamped to availableQty and merchant leverage rises", async () => {
    const tight: CatalogItemSnapshot = { ...wellStocked, availableQty: 80 };
    const tightListing: PublicManifestProduct = { ...wellStockedListing, availableQuantity: 80 };
    const { transcript } = await runNegotiationToCompletion(
      {
        item: tight,
        manifestProduct: tightListing,
        buyerConstraints: { sku: "MONITOR-24-FHD", quantity: 400, maxUnitPrice: 9200, deliveryDeadlineDays: 6 },
      },
      6,
    );
    for (const turn of transcript) {
      if (turn.merchant.quantity !== null) {
        expect(turn.merchant.quantity).toBeLessThanOrEqual(tight.availableQty);
      }
    }
    const firstTurn = transcript[0];
    expect(firstTurn.merchant.type).toBe("counter_offer"); // PARTIAL_FULFILLMENT, not an outright accept
    expect(firstTurn.leverage.merchantLeverage).toBeGreaterThan(50);
  });

  // urgent delivery + low stock -> merchant firm, but the buyer's own
  // ceiling is still never breached.
  it("urgent delivery against tight stock: merchant leverage is high, buyer never exceeds its ceiling", async () => {
    const tight: CatalogItemSnapshot = { ...wellStocked, availableQty: 40 };
    const tightListing: PublicManifestProduct = { ...wellStockedListing, availableQuantity: 40 };
    const { transcript } = await runNegotiationToCompletion(
      {
        item: tight,
        manifestProduct: tightListing,
        buyerConstraints: {
          sku: "MONITOR-24-FHD",
          quantity: 30,
          maxUnitPrice: 9300,
          deliveryDeadlineDays: 4, // == standardDeliveryDays, no slack -> genuinely urgent
          urgency: "high",
        },
      },
      6,
    );
    expect(transcript[0].leverage.merchantLeverage).toBeGreaterThan(50);
    for (const turn of transcript) {
      if (turn.buyer.unitPrice !== null) {
        expect(turn.buyer.unitPrice).toBeLessThanOrEqual(9300);
      }
    }
  });

  // flexible delivery + large quantity -> buyer gets a later delivery
  // date AND still respects its own price ceiling.
  it("flexible delivery combined with a large order: delivery extends beyond standard, price ceiling still respected", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion(
      {
        item: wellStocked,
        manifestProduct: wellStockedListing,
        buyerConstraints: {
          sku: "MONITOR-24-FHD",
          quantity: 350,
          maxUnitPrice: 9300,
          deliveryDeadlineDays: 12, // real slack beyond standardDeliveryDays (4)
          deliveryFlexible: true,
        },
      },
      6,
    );
    const tradedTurn = transcript.find((t) => (t.merchant.deliveryDays ?? 0) > wellStocked.standardDeliveryDays);
    expect(tradedTurn).toBeDefined();
    for (const turn of transcript) {
      if (turn.buyer.unitPrice !== null) {
        expect(turn.buyer.unitPrice).toBeLessThanOrEqual(9300);
      }
    }
    expect(["AGREED", "COUNTERED", "EXPIRED"]).toContain(finalState.status);
  });

  // urgent delivery + flexible delivery together must resolve
  // consistently: the delivery trade depends only on deadline slack +
  // the flexibility flag, not on urgency, so two otherwise-identical
  // negotiations differing only in urgency should extend delivery by
  // the exact same amount.
  it("urgency and delivery flexibility resolve independently and consistently", async () => {
    const buildConstraints = (urgency: "low" | "high"): BuyerConstraints => ({
      sku: "MONITOR-24-FHD",
      quantity: 30,
      maxUnitPrice: 9300,
      deliveryDeadlineDays: 10,
      deliveryFlexible: true,
      urgency,
    });

    const highUrgency = await runNegotiationToCompletion(
      { item: wellStocked, manifestProduct: wellStockedListing, buyerConstraints: buildConstraints("high") },
      6,
    );
    const lowUrgency = await runNegotiationToCompletion(
      { item: wellStocked, manifestProduct: wellStockedListing, buyerConstraints: buildConstraints("low") },
      6,
    );

    expect(highUrgency.transcript[0].merchant.deliveryDays).toBe(
      lowUrgency.transcript[0].merchant.deliveryDays,
    );
    // But urgency still shapes price leverage independently of delivery.
    expect(highUrgency.transcript[0].leverage.buyerLeverage).toBeLessThan(
      lowUrgency.transcript[0].leverage.buyerLeverage,
    );
  });

  // large quantity + budget constraint -> quantity leverage never lets
  // the buyer exceed its own stated maximum.
  it("a large order never lets the buyer exceed its own maxUnitPrice, however strong its leverage", async () => {
    const { transcript } = await runNegotiationToCompletion(
      {
        item: wellStocked,
        manifestProduct: wellStockedListing,
        buyerConstraints: { sku: "MONITOR-24-FHD", quantity: 800, maxUnitPrice: 8900, deliveryDeadlineDays: 6 },
      },
      6,
    );
    for (const turn of transcript) {
      if (turn.buyer.unitPrice !== null) {
        expect(turn.buyer.unitPrice).toBeLessThanOrEqual(8900);
      }
    }
  });

  // large quantity + flexible delivery + high stock -> every buyer-favoring
  // factor stacked; still bounded by the merchant's floor.
  it("stacking every buyer-favoring factor still never breaches the merchant's floor", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion(
      {
        item: wellStocked,
        manifestProduct: wellStockedListing,
        buyerConstraints: {
          sku: "MONITOR-24-FHD",
          quantity: 600,
          maxUnitPrice: 9400,
          deliveryDeadlineDays: 12,
          deliveryFlexible: true,
          urgency: "low",
        },
      },
      6,
    );
    expect(transcript[0].leverage.buyerLeverage).toBeGreaterThan(60);
    for (const turn of transcript) {
      if (turn.merchant.unitPrice !== null) {
        expect(turn.merchant.unitPrice).toBeGreaterThanOrEqual(wellStocked.minPrice);
      }
    }
    expect(["AGREED", "COUNTERED", "EXPIRED"]).toContain(finalState.status);
  });

  // Walk-away still works correctly with every strategic factor active
  // at once — no fake agreement, no agreement persistence trigger.
  it("an impossible budget still walks away (EXPIRED) even with maximal buyer-favoring strategic factors", async () => {
    const { finalState, transcript } = await runNegotiationToCompletion(
      {
        item: wellStocked,
        manifestProduct: wellStockedListing,
        buyerConstraints: {
          sku: "MONITOR-24-FHD",
          quantity: 500,
          maxUnitPrice: 5000, // below the 8200 floor -> impossible regardless of leverage
          deliveryDeadlineDays: 12,
          deliveryFlexible: true,
          urgency: "low",
        },
      },
      2,
    );
    expect(finalState.status).toBe("EXPIRED");
    expect(transcript[transcript.length - 1].merchant.type).not.toBe("accept");
    for (const turn of transcript) {
      if (turn.merchant.unitPrice !== null) {
        expect(turn.merchant.unitPrice).toBeGreaterThanOrEqual(wellStocked.minPrice);
      }
    }
  });
});

// PACT V2 Milestone 1: proves the merchant's conditional quantity <->
// price trade evaluator (merchantTradeEvaluator.ts) actually flows
// through the full turn-based orchestrator, not just merchantAgent.ts's
// own direct-call tests — the real end-to-end path a live negotiation uses.
describe("conditional merchant trade flows through the real orchestrator", () => {
  const bulkItem: CatalogItemSnapshot = {
    sku: "MONITOR-24-FHD",
    listedPrice: 9500,
    minPrice: 8200,
    availableQty: 5000, // abundant
    standardDeliveryDays: 4,
    maxDeliveryDays: 10,
    negotiationEnabled: true,
  };
  const bulkListing: PublicManifestProduct = {
    sku: "MONITOR-24-FHD",
    name: "24-inch Full HD Monitor",
    description: "Standard office monitor, 1920x1080.",
    listedPrice: 9500,
    availableQuantity: 5000,
    standardDeliveryDays: 4,
    maxDeliveryDays: 10,
    negotiable: true,
  };

  it("a bulk opening request against abundant stock reaches AGREED with the trade-evaluated price, not the plain baseline", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion(
      {
        item: bulkItem,
        manifestProduct: bulkListing,
        buyerConstraints: { sku: "MONITOR-24-FHD", quantity: 350, maxUnitPrice: 9200, deliveryDeadlineDays: 6 },
      },
      6,
    );

    expect(finalState.status).not.toBe("REJECTED");
    for (const turn of transcript) {
      if (turn.merchant.unitPrice !== null) {
        expect(turn.merchant.unitPrice).toBeGreaterThanOrEqual(bulkItem.minPrice);
        expect(turn.merchant.unitPrice).toBeLessThanOrEqual(bulkItem.listedPrice);
      }
    }
  });

  it("the identical bulk request against scarce stock converges to a worse (higher) price for the buyer than against abundant stock", async () => {
    const scarceItem: CatalogItemSnapshot = { ...bulkItem, availableQty: 20 };
    const scarceListing: PublicManifestProduct = { ...bulkListing, availableQuantity: 20 };
    const buyerConstraints = {
      sku: "MONITOR-24-FHD",
      quantity: 300,
      maxUnitPrice: 9200,
      deliveryDeadlineDays: 6,
    };

    const abundantRun = await runNegotiationToCompletion(
      { item: bulkItem, manifestProduct: bulkListing, buyerConstraints },
      6,
    );
    // Same buyer ask (still requesting 300, a bulk order by
    // hasQuantityLeverage's threshold) against scarce stock — the
    // request itself is unchanged; only the merchant's own inventory
    // state differs, which is exactly what should drive the difference.
    const scarceRun = await runNegotiationToCompletion(
      { item: scarceItem, manifestProduct: scarceListing, buyerConstraints },
      6,
    );

    const abundantFirstOffer = abundantRun.transcript[0].merchant.unitPrice!;
    const scarceFirstOffer = scarceRun.transcript[0].merchant.unitPrice!;
    expect(abundantFirstOffer).toBeLessThan(scarceFirstOffer);
  });
});
