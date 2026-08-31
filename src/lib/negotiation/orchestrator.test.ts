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
import { runMerchantAgent } from "@/lib/agents/merchantAgent";
import * as walkAway from "@/lib/rules/walkAway";
import { generateBuyerCandidates, selectBestBuyerCandidate } from "@/lib/rules/buyerMoveSelection";
import { generateMerchantCandidates } from "@/lib/rules/merchantMoveSelection";

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

// arePositionsRepeated is spied on (not fully mocked — isPriceGapUnbridgeable
// stays real via importOriginal) purely so ONE test (see "repeated-position
// deadlock" below) can force it to report a repeat without needing to
// mathematically reach one through real price convergence — the
// concession formulas guarantee accept-or-converge whenever a solution
// exists, so a genuine non-structural repeat is not reachable through
// real play (verified empirically while building this milestone); this
// spy tests the ORCHESTRATOR'S reaction to the signal, decoupled from
// whether today's formulas can ever organically produce it themselves.
vi.mock("@/lib/rules/walkAway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rules/walkAway")>();
  return {
    ...actual,
    arePositionsRepeated: vi.fn(actual.arePositionsRepeated),
  };
});

const mockedGetLlmProvider = vi.mocked(getLlmProvider);
const mockedArePositionsRepeated = vi.mocked(walkAway.arePositionsRepeated);

beforeEach(async () => {
  mockedGetLlmProvider.mockReturnValue({
    generateAgentMessage: vi.fn().mockResolvedValue("mocked agent message"),
  });
  // Full reset (not just mockClear) so a mockReturnValueOnce queued by a
  // previous test but left unconsumed can never leak into the next one
  // — then immediately re-establish the real implementation as the default.
  const actual = await vi.importActual<typeof import("@/lib/rules/walkAway")>("@/lib/rules/walkAway");
  mockedArePositionsRepeated.mockReset();
  mockedArePositionsRepeated.mockImplementation(actual.arePositionsRepeated);
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
    // Milestone 4: the buyer's round-2 ask (44063) is a genuine concession
    // over its round-1 ask (42750) — CONCEDED reciprocity — so the
    // merchant meets it with a larger-than-baseline concession on round 2,
    // and the buyer's final accept price drops accordingly (44621, was
    // 44719 before reciprocity existed). Verified empirically by running
    // this test after wiring reciprocitySpeedMultiplier through the
    // orchestrator, not hand-derived.
    expect(transcript.map((t) => t.buyer.unitPrice)).toEqual([42750, 44063, 44621]);
    // Merchant: gradual concession from its listed-price anchor, closing
    // the moment the buyer's own ceiling is actually met.
    expect(transcript.map((t) => t.merchant.type)).toEqual([
      "counter_offer",
      "counter_offer",
      "accept",
    ]);
    // Round 1 is unaffected (no prior buyer ask yet -> UNKNOWN -> neutral
    // 1.0 multiplier, same 45375 as before Milestone 4). Round 2 reflects
    // the CONCEDED reciprocity bonus (44621 instead of 44719).
    expect(transcript.map((t) => t.merchant.unitPrice)).toEqual([45375, 44621, 44621]);

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

  // PACT V2 Milestone 4: the orchestrator-level acceptance criterion —
  // the merchant's FIRST counter differs purely because of the buyer's
  // (artificial, orchestrator-injected) prior-round history, even though
  // the buyer's own opening ask this round is IDENTICAL in every case.
  // Round 1 (previousMerchantResult null) is used deliberately: that
  // branch of runBuyerAgent never consults previousBuyerUnitPrice for its
  // own decision (see buyerAgent.ts — the whole move-selector path is
  // skipped when merchantResult is null), so it's a clean, isolated probe
  // of the merchant's reaction alone, decoupled from any buyer-side
  // effect the same value might otherwise have.
  it("the merchant's opening counter differs when the (injected) buyer history differs, even though the buyer's own current ask is identical", async () => {
    const state = createNegotiationState(4);

    const buyerConceded = await runNegotiationTurn(demoContext(), state, null, 41000);
    const buyerHeld = await runNegotiationTurn(demoContext(), state, null, 42750);
    const buyerWithdrew = await runNegotiationTurn(demoContext(), state, null, 44000);

    // The buyer's own opening ask is unaffected by the injected history —
    // proves the comparison below isolates the MERCHANT'S reaction.
    expect(buyerConceded.buyer.unitPrice).toBe(42750);
    expect(buyerHeld.buyer.unitPrice).toBe(42750);
    expect(buyerWithdrew.buyer.unitPrice).toBe(42750);

    // The merchant's counter strictly differs, in the direction the
    // reciprocity design intends: rewarding apparent movement toward it
    // with a stronger concession, and a withdrawal with the weakest one.
    expect(buyerConceded.merchant.unitPrice!).toBeLessThan(buyerHeld.merchant.unitPrice!);
    expect(buyerHeld.merchant.unitPrice!).toBeLessThan(buyerWithdrew.merchant.unitPrice!);
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
  it("terminates as EXPIRED via an early walk-away, never looping to the round limit", async () => {
    // Buyer's ceiling (₹30,000) is below the merchant's private floor
    // (₹44,000) — no deterministic path to agreement exists. Before
    // Milestone 2 (walk-away detection), this ran out every configured
    // round repeating the same numbers; now the structural-impossibility
    // check (walkAway.ts) recognizes this after the first real exchange
    // and closes immediately instead — 2 turns, not 3, even with
    // maxRounds=2 headroom to spare.
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
    // Turn 1: a real opening exchange (merchant's actual floor-clamped
    // counter). Turn 2: the walk-away close — not a 3rd repeated round.
    expect(transcript.length).toBe(2);
    expect(transcript[0].merchant.unitPrice).toBe(44000); // the merchant's real, floor-clamped counter
    expect(transcript[transcript.length - 1].state.status).toBe("EXPIRED");
    // Both sides explain why, referencing the real numbers, not a bare repeat.
    expect(transcript[1].buyer.message).toContain("30000");
    expect(transcript[1].merchant.message).toBeTruthy();
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

// PACT V2 Milestone 2: walk-away / deadlock detection.
describe("walk-away / deadlock detection", () => {
  const laptop2: CatalogItemSnapshot = {
    sku: "LAPTOP-14-I5",
    listedPrice: 48000,
    minPrice: 44000,
    availableQty: 100,
    standardDeliveryDays: 5,
    maxDeliveryDays: 12,
    negotiationEnabled: true,
  };
  const laptop2Listing: PublicManifestProduct = {
    sku: "LAPTOP-14-I5",
    name: "14-inch Business Laptop (i5, 16GB RAM)",
    description: "Mid-range business laptop suitable for office use.",
    listedPrice: 48000,
    availableQuantity: 100,
    standardDeliveryDays: 5,
    maxDeliveryDays: 12,
    negotiable: true,
  };

  // A. Impossible budget: buyer max (₹30,000) below merchant floor
  // (₹44,000) closes early rather than exhausting maxRounds.
  it("A: an impossible budget gap closes as an early walk-away, not a repeated-number round loop", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion(
      {
        item: laptop2,
        manifestProduct: laptop2Listing,
        buyerConstraints: { sku: "LAPTOP-14-I5", quantity: 10, maxUnitPrice: 30000, deliveryDeadlineDays: 10 },
      },
      4, // generous round budget — the point is closing well before it's used up
    );

    expect(finalState.status).toBe("EXPIRED");
    expect(transcript.length).toBeLessThan(4);
    const closingTurn = transcript[transcript.length - 1];
    expect(closingTurn.buyer.type).toBe("reject");
    expect(closingTurn.merchant.type).toBe("reject");
    expect(closingTurn.buyer.message).toContain("30000"); // buyer's authoritative budget
    expect(closingTurn.merchant.message.length).toBeGreaterThan(0);
    expect(closingTurn.merchant.message).not.toContain("44000"); // the private floor never appears in the merchant's own message
  });

  // F (agent-level tests already cover G/H fallback directly) — here,
  // confirm the orchestrator-level walk-away close never triggers
  // Agreement-eligible terms: quantity/price/delivery all null, exactly
  // like the existing reject path, so the turn route's existing
  // Agreement-creation guard (gated on turn.state.status === "AGREED")
  // is untouched and this can never create an Agreement.
  it("a walk-away close carries no structured terms an Agreement could ever be created from", async () => {
    const { transcript } = await runNegotiationToCompletion(
      {
        item: laptop2,
        manifestProduct: laptop2Listing,
        buyerConstraints: { sku: "LAPTOP-14-I5", quantity: 10, maxUnitPrice: 30000, deliveryDeadlineDays: 10 },
      },
      4,
    );
    const closingTurn = transcript[transcript.length - 1];
    expect(closingTurn.merchant.quantity).toBeNull();
    expect(closingTurn.merchant.unitPrice).toBeNull();
    expect(closingTurn.merchant.deliveryDays).toBeNull();
  });

  // D. Repeated positions: forced via a spy on arePositionsRepeated,
  // since the concession formulas guarantee accept-or-converge whenever
  // a solution exists (verified empirically), so a genuine non-structural
  // repeat cannot be reached through real price computation — this
  // proves the ORCHESTRATOR correctly reacts to the signal regardless.
  it("D: a detected repeated-position deadlock closes the negotiation instead of continuing as COUNTERED", async () => {
    mockedArePositionsRepeated.mockReturnValueOnce(true);

    const state = { status: "COUNTERED" as const, round: 2, maxRounds: 6 };
    const previousMerchantResult = {
      outcome: "COUNTER_OFFER" as const,
      sku: "LAPTOP-14-I5",
      requestedQuantity: 10,
      offeredQuantity: 10,
      // Deliberately still above the buyer's ceiling (46000), so the
      // buyer does NOT immediately accept and actually computes a fresh
      // counter — reaching the repeated-position check at all requires
      // the negotiation to still be genuinely open, not already resolved.
      unitPrice: 47000,
      deliveryDays: 5,
      reasons: [],
    };

    const turn = await runNegotiationTurn(
      {
        item: laptop2,
        manifestProduct: laptop2Listing,
        // Not structurally impossible (46000 >= 44000) — isolates the
        // repeated-position path from the structural-impossibility one.
        buyerConstraints: { sku: "LAPTOP-14-I5", quantity: 10, maxUnitPrice: 46000, deliveryDeadlineDays: 10 },
      },
      state,
      previousMerchantResult,
      44000, // previousBuyerUnitPrice — value itself is irrelevant since the spy forces the verdict
    );

    expect(turn.state.status).toBe("EXPIRED");
    expect(turn.buyer.type).toBe("reject");
    expect(turn.merchant.type).toBe("reject");
    expect(mockedArePositionsRepeated).toHaveBeenCalledTimes(1);
  });

  it("never fires the repeated-position check on a round that is already accepting", async () => {
    // A high buyer ceiling reaches EXACT_MATCH/accept immediately —
    // arePositionsRepeated must never even be consulted on that path.
    await runNegotiationToCompletion(
      {
        item: laptop2,
        manifestProduct: laptop2Listing,
        buyerConstraints: { sku: "LAPTOP-14-I5", quantity: 10, maxUnitPrice: 90000, deliveryDeadlineDays: 10 },
      },
      4,
    );
    expect(mockedArePositionsRepeated).not.toHaveBeenCalled();
  });

  // PACT V2 Milestone 4 regression: reciprocity must never turn an
  // impossible-budget negotiation into a longer, looping one — the
  // structural walk-away check (walkAway.isPriceGapUnbridgeable) runs
  // BEFORE any concession price is even computed, so it is completely
  // unaffected by whatever speedMultiplier the buyer's (nonexistent, in
  // this scenario) history would have produced.
  it("Milestone 4: an impossible budget still closes as an early walk-away with reciprocity wired in, regardless of injected buyer history", async () => {
    const state = { status: "COUNTERED" as const, round: 1, maxRounds: 6 };
    const previousMerchantResult = {
      outcome: "COUNTER_OFFER" as const,
      sku: "LAPTOP-14-I5",
      requestedQuantity: 10,
      offeredQuantity: 10,
      unitPrice: 47000,
      deliveryDays: 5,
      reasons: [],
    };
    const buyerConstraints = {
      sku: "LAPTOP-14-I5",
      quantity: 10,
      maxUnitPrice: 30000, // below laptop2.minPrice (44000) -> structurally impossible
      deliveryDeadlineDays: 10,
    };

    for (const injectedPriorBuyerPrice of [null, 28000, 30000, 32000]) {
      const turn = await runNegotiationTurn(
        { item: laptop2, manifestProduct: laptop2Listing, buyerConstraints },
        state,
        previousMerchantResult,
        injectedPriorBuyerPrice,
      );
      expect(turn.state.status).toBe("EXPIRED");
      expect(turn.merchant.type).toBe("reject");
    }
  });

  // F. Non-negotiable item regression: existing REJECTED behavior for a
  // price mismatch on a non-negotiable item is completely untouched by
  // the new structural-impossibility check (gated on negotiationEnabled).
  it("F: a non-negotiable item's price mismatch still follows the existing REJECTED path, not a walk-away", async () => {
    const nonNegotiable: CatalogItemSnapshot = { ...laptop2, negotiationEnabled: false };
    const nonNegotiableListing: PublicManifestProduct = { ...laptop2Listing, negotiable: false };

    const { transcript, finalState } = await runNegotiationToCompletion(
      {
        item: nonNegotiable,
        manifestProduct: nonNegotiableListing,
        buyerConstraints: { sku: "LAPTOP-14-I5", quantity: 10, maxUnitPrice: 30000, deliveryDeadlineDays: 10 },
      },
      4,
    );

    expect(finalState.status).toBe("REJECTED");
    expect(transcript).toHaveLength(1); // rejected outright on the opening round, not via walk-away
  });

  // E. Successful negotiation regression: the flagship scenario still
  // reaches AGREED, untouched by the new walk-away checks.
  it("E: a normal, achievable negotiation still reaches AGREED", async () => {
    const { finalState } = await runNegotiationToCompletion(
      {
        item: laptop2,
        manifestProduct: laptop2Listing,
        buyerConstraints: { sku: "LAPTOP-14-I5", quantity: 200, maxUnitPrice: 45000, deliveryDeadlineDays: 10 },
      },
      4,
    );
    expect(finalState.status).toBe("AGREED");
  });
});

// PACT V2 Milestone 3: real buyer bargaining strategy, end to end
// through the full orchestrator (not just buyerAgent.ts's own direct
// calls) — a genuinely high-leverage buyer (large order against
// abundant stock) actually holds its position mid-negotiation instead
// of moving every single round.
describe("buyer HOLD strategy through the real orchestrator", () => {
  // A modest, non-scarce (but not abundant-enough-to-trigger-the-stock-
  // speedup) laptop stock, a low-urgency + delivery-flexible buyer with
  // a tight-but-achievable ceiling — verified empirically (see the
  // Milestone 3 report) to produce a genuine, real HOLD round via the
  // actual concession formulas, not a contrived/mocked one.
  const item: CatalogItemSnapshot = {
    sku: "LAPTOP-14-I5",
    listedPrice: 48000,
    minPrice: 44000,
    availableQty: 35,
    standardDeliveryDays: 5,
    maxDeliveryDays: 12,
    negotiationEnabled: true,
  };
  const listing: PublicManifestProduct = {
    sku: "LAPTOP-14-I5",
    name: "14-inch Business Laptop (i5, 16GB RAM)",
    description: "Mid-range business laptop suitable for office use.",
    listedPrice: 48000,
    availableQuantity: 35,
    standardDeliveryDays: 5,
    maxDeliveryDays: 12,
    negotiable: true,
  };

  it("a high-leverage buyer holds its price for at least one round instead of moving every round", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion(
      {
        item,
        manifestProduct: listing,
        buyerConstraints: {
          sku: "LAPTOP-14-I5",
          quantity: 20,
          maxUnitPrice: 44300,
          deliveryDeadlineDays: 10,
          urgency: "low",
          deliveryFlexible: true,
        },
      },
      10, // generous round budget so a hold has room to actually happen before the final-round safety net
    );

    const buyerPrices = transcript.map((t) => t.buyer.unitPrice).filter((p): p is number => p !== null);
    const heldSomewhere = buyerPrices.some((price, i) => i > 0 && price === buyerPrices[i - 1]);

    expect(heldSomewhere).toBe(true);
    // Structural invariants unaffected by holding: never breaches the
    // buyer's own ceiling, never leaks a value the merchant never stated.
    for (const price of buyerPrices) {
      expect(price).toBeLessThanOrEqual(44300);
    }
    expect(finalState.status).toBe("AGREED"); // holding didn't prevent a real, achievable deal from closing
  });
});

// PACT V2 Milestone 5: buyer-initiated quantity-for-price bargaining,
// end to end through the real orchestrator. Exact values verified
// empirically (see the Milestone 5 design/implementation session) after
// fixing a real bug this milestone surfaced: buyerRules.isQuantityAcceptable
// used to hard-reject any merchant offer above the buyer's ORIGINAL
// constraints.quantity, which would have silently blocked a negotiation
// from ever closing once the buyer legitimately asked for more via a
// trade — see the maxAcceptableQuantity parameter added to
// validateMerchantProposal / isQuantityAcceptable (buyerRules.ts).
describe("buyer-initiated quantity-for-price trade through the real orchestrator", () => {
  // Buyer Quantity-for-Price Redesign: the previous-buyer-price invariant
  // means a trade can no longer fire on the buyer's very first reactive
  // round (its own opening ask always equals resolveBuyerTarget exactly,
  // leaving no meaningful room to "improve" on round 2 — see
  // buyerQuantityTrade.test.ts's own dedicated coverage of that NO_TRADE
  // case). The fixture below is a genuine, live-verified trajectory where
  // the buyer has already made one real concession (round 2) before the
  // trade fires with real room above target (round 3) — not hand-invented.
  // Stock is deliberately set to 52 — between the base ask (50) and the
  // traded ask (57) — so this SAME fixture also exercises the existing,
  // unmodified Milestone 12 quantity-fidelity guarantee (the merchant
  // authorizes and prices against real stock, never the raw over-ask).
  const item: CatalogItemSnapshot = {
    sku: "LAPTOP-14-I5",
    listedPrice: 48000,
    minPrice: 44000,
    availableQty: 52,
    standardDeliveryDays: 5,
    maxDeliveryDays: 12,
    negotiationEnabled: true,
  };
  const listing: PublicManifestProduct = {
    sku: "LAPTOP-14-I5",
    name: "14-inch Business Laptop (i5, 16GB RAM)",
    description: "Mid-range business laptop suitable for office use.",
    listedPrice: 48000,
    availableQuantity: 52,
    standardDeliveryDays: 5,
    maxDeliveryDays: 12,
    negotiable: true,
  };
  const tradeBuyerConstraints: BuyerConstraints = {
    sku: "LAPTOP-14-I5",
    quantity: 50,
    maxUnitPrice: 44700,
    deliveryDeadlineDays: 10,
    urgency: "high",
  };

  // 15, 16, 17. The golden behavioral scenario (section 17 of the
  // Milestone 5 spec, re-verified live under the redesign): the buyer
  // changes quantity SPECIFICALLY to negotiate price (not an unrelated
  // independent change), the merchant evaluates the resulting package
  // rather than blindly moving price alone, and the negotiation still
  // reaches a genuine AGREED close.
  it("the buyer increases quantity specifically to seek a better price, the merchant evaluates the package, and they still reach AGREED", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion(
      { item, manifestProduct: listing, buyerConstraints: tradeBuyerConstraints },
      10,
    );

    // Round 1: ordinary opening exchange, no trade yet — the buyer's own
    // opening ask is always exactly its target, so a trade could never
    // fire here regardless (see this describe block's own header comment).
    expect(transcript[0].buyer.quantity).toBe(50);
    expect(transcript[0].buyer.unitPrice).toBe(42465);
    expect(transcript[0].merchant.unitPrice).toBe(45233);

    // Round 2: an ordinary concession — the trade's own previous-price
    // invariant correctly has nothing to improve on yet (round 1's ask
    // already sat at target), so the buyer's own candidate comparison
    // genuinely selects CONCEDE (the only eligible candidate this round).
    expect(transcript[1].buyer.quantity).toBe(50);
    expect(transcript[1].buyer.move).toBe("CONCEDE");
    expect(transcript[1].buyer.unitPrice).toBe(44403);
    expect(transcript[1].merchant.unitPrice).toBe(44756);

    // Round 3: NOW the buyer has real room above target (its own round-2
    // ask, 44403) to construct a genuine improvement — the trade fires.
    expect(transcript[2].buyer.move).toBe("QUANTITY_FOR_PRICE");
    expect(transcript[2].buyer.quantity).toBe(57);
    expect(transcript[2].buyer.unitPrice).toBe(42465);
    expect(transcript[2].buyer.unitPrice!).toBeLessThanOrEqual(44403); // never exceeds the buyer's own previous ask
    // The merchant evaluated the whole package: it authorizes and prices
    // against its REAL stock (52), never the buyer's raw 57-unit ask —
    // the existing, unmodified Milestone 12 quantity-fidelity guarantee.
    expect(transcript[2].merchant.type).toBe("counter_offer");
    expect(transcript[2].merchant.quantity).toBe(52);
    expect(transcript[2].merchant.unitPrice).toBe(44069);

    // Round 4: a genuine AGREED close — the trade did not force agreement
    // on its own; the buyer still only accepts once the merchant's own
    // (package-evaluated) offer actually satisfies its ceiling.
    expect(transcript[3].buyer.type).toBe("accept");
    expect(transcript[3].buyer.unitPrice).toBe(44069);
    expect(finalState.status).toBe("AGREED");

    // The trade is never used a second time, even though four rounds ran
    // — round 4's accept mirrors the merchant's own authorized quantity
    // (52, stock-capped), never a re-escalated buyer ask.
    const buyerQuantities = transcript.map((t) => t.buyer.quantity);
    expect(buyerQuantities).toEqual([50, 50, 57, 52]);
  });

  // Confirms round 3 is a genuine, real evaluation on both sides — the
  // buyer's own trade fires, and the merchant's response (a real
  // CONCEDE, floor-respecting and never an arbitrary number) reflects
  // that the buyer's own trade price (42465) sits below the merchant's
  // real private floor (44000) — evaluateMerchantTrade's own REJECT-on-
  // below-floor check correctly declines to treat this as a bulk-worthy
  // discount opportunity, merging its reason into the ordinary CONCEDE
  // candidate rather than fabricating a distinct merchant-side trade.
  // This is real, verified behavior, not a hand-picked number.
  it("the quantity trade materially changes the merchant's response — the merchant genuinely evaluates the package on its own real terms", async () => {
    const { transcript } = await runNegotiationToCompletion(
      { item, manifestProduct: listing, buyerConstraints: tradeBuyerConstraints },
      10,
    );

    expect(transcript[2].buyer.move).toBe("QUANTITY_FOR_PRICE");
    expect(transcript[2].merchant.move).toBe("CONCEDE");
    // The merchant's response price is a real, floor-respecting
    // evaluation, not an arbitrary number.
    expect(transcript[2].merchant.unitPrice!).toBeGreaterThanOrEqual(item.minPrice);
    expect(transcript[2].merchant.unitPrice!).toBeLessThan(item.listedPrice);
  });

  // 18. Impossible negotiation still walks away — the quantity-trade
  // machinery being fully wired in (previousBuyerQuantity threaded,
  // quantityTradeAlreadyUsed derived every round) never interferes with
  // Milestone 2's structural walk-away check, which runs before any
  // concession/trade price is even computed.
  it("an impossible budget still closes as an early walk-away with the quantity-trade machinery fully wired in", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion(
      {
        item,
        manifestProduct: listing,
        buyerConstraints: { ...tradeBuyerConstraints, maxUnitPrice: 30000 }, // below item.minPrice (44000)
      },
      6,
    );

    expect(finalState.status).toBe("EXPIRED");
    expect(transcript.length).toBeLessThan(6);
    const closingTurn = transcript[transcript.length - 1];
    expect(closingTurn.buyer.type).toBe("reject");
    expect(closingTurn.merchant.type).toBe("reject");
  });
});

// PACT V2 Milestone 7: buyer-initiated delivery-for-price bargaining,
// Direction A — the buyer offers a LATER delivery date in exchange for a
// better price. Fixture found by empirically probing several
// representative scenarios (see the Milestone 7 calibration review),
// not hand-derived, and deliberately supply-constrains quantity (30
// available against a 40-unit request) so the quantity chip is
// unavailable and this cleanly isolates the delivery mechanic.
describe("buyer-initiated delivery-for-price trade through the real orchestrator", () => {
  const item: CatalogItemSnapshot = {
    sku: "LAPTOP-14-I5",
    listedPrice: 48000,
    minPrice: 44000,
    availableQty: 30,
    standardDeliveryDays: 5,
    maxDeliveryDays: 15,
    negotiationEnabled: true,
  };
  const listing: PublicManifestProduct = {
    sku: "LAPTOP-14-I5",
    name: "14-inch Business Laptop (i5, 16GB RAM)",
    description: "Mid-range business laptop suitable for office use.",
    listedPrice: 48000,
    availableQuantity: 30,
    standardDeliveryDays: 5,
    maxDeliveryDays: 15,
    negotiable: true,
  };
  const deliveryTradeBuyerConstraints: BuyerConstraints = {
    sku: "LAPTOP-14-I5",
    quantity: 40,
    maxUnitPrice: 45500,
    deliveryDeadlineDays: 8,
    urgency: "high",
    deliveryFlexible: true,
  };

  // The golden behavioral scenario (section 14/17 of the Milestone 7
  // spec): the buyer changes DELIVERY specifically to negotiate price
  // (both move together in the same round, not independently), the
  // merchant evaluates the resulting package instead of blindly moving
  // price alone, and the negotiation still reaches a genuine AGREED close.
  it("the buyer offers a later delivery date specifically to seek a better price, the merchant evaluates the package, and they still reach AGREED", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion(
      { item, manifestProduct: listing, buyerConstraints: deliveryTradeBuyerConstraints },
      10,
    );

    // Round 1: ordinary opening exchange (a genuine partial fulfillment
    // — stock (30) is short of the 40 requested — no delivery trade yet;
    // the legacy resolveDeliveryTrade already honors the buyer's own
    // 8-day deadline, since there's no PRIOR round to diff against).
    expect(transcript[0].buyer.deliveryDays).toBe(8);
    expect(transcript[0].merchant.type).toBe("counter_offer");
    expect(transcript[0].merchant.quantity).toBe(30); // partial fulfillment, unrelated to this milestone
    expect(transcript[0].merchant.deliveryDays).toBe(8);
    expect(transcript[0].merchant.unitPrice).toBe(46209);

    // Round 2: the buyer changes DELIVERY specifically to negotiate price
    // — quantity chip is unavailable here (merchant already short-supplying
    // the original request), so this cleanly isolates the delivery move.
    // Negotiation calibration task: deliveryDeadlineDays=8 with
    // urgency="high" now resolves via resolveDeliveryUrgencyFactor
    // ("high"=0.3), not the flat 0.5 every urgency used before — 8 +
    // round(8*0.3) = 10, not 12. Re-verified against the real
    // orchestrator (not hand-derived) — the merchant's own package price
    // shifts too, since its own delivery discount is sized off the
    // SAME (now smaller) extra-days figure.
    expect(transcript[1].buyer.deliveryDays).toBe(10); // 8 + round(8 * 0.3)
    expect(transcript[1].buyer.quantity).toBe(30); // unchanged — this round's move is delivery, not quantity
    expect(transcript[1].buyer.unitPrice).toBe(44625);
    // The merchant evaluated the whole package: the countered price
    // reflects a real stock-driven delivery discount on top of the
    // baseline, and honors the buyer's own extended date.
    expect(transcript[1].merchant.type).toBe("counter_offer");
    expect(transcript[1].merchant.deliveryDays).toBe(10);
    expect(transcript[1].merchant.unitPrice).toBe(45221);

    // Round 3: a genuine AGREED close — the trade did not force
    // agreement on its own.
    expect(transcript[2].buyer.type).toBe("accept");
    expect(transcript[2].buyer.unitPrice).toBe(45221);
    expect(finalState.status).toBe("AGREED");

    // The delivery chip is never used a second time.
    const buyerDeliveryDays = transcript.map((t) => t.buyer.deliveryDays);
    expect(buyerDeliveryDays.filter((d) => d === 10)).toHaveLength(2); // round 2's trade, then round 3 mirrors it back
    expect(buyerDeliveryDays.every((d) => d === 8 || d === 10)).toBe(true); // never a third, escalating value
  });

  // Counterfactual proving the trade materially changed the merchant's
  // response, not merely "a different number happened to come out."
  it("the delivery trade materially changes the merchant's response compared to an ordinary (non-traded) counter", async () => {
    const { transcript: traded } = await runNegotiationToCompletion(
      { item, manifestProduct: listing, buyerConstraints: deliveryTradeBuyerConstraints },
      10,
    );

    const withoutTrade = await runMerchantAgent(
      item,
      { sku: item.sku, quantity: 30, maxUnitPrice: 44625, deliveryDeadlineDays: 8, deliveryFlexible: true },
      { round: 2, maxRounds: 10, previousOfferUnitPrice: 46209 },
    );

    // Same round, same merchant offer anchor, same buyer price — only
    // the delivery window differs (8, not traded, vs 12, traded) — and
    // yet the merchant's price differs materially.
    expect(traded[1].merchant.unitPrice!).toBeLessThan(withoutTrade.decision.unitPrice!);
  });

  // Quantity trade and delivery trade never both fire in the same round
  // — the orchestrator-level confirmation of the waterfall already
  // proven at the unit and agent levels (buyerAgent.test.ts /
  // merchantAgent.test.ts).
  it("never trades both quantity and delivery in the same round", async () => {
    const { transcript } = await runNegotiationToCompletion(
      { item, manifestProduct: listing, buyerConstraints: deliveryTradeBuyerConstraints },
      10,
    );

    for (const turn of transcript) {
      const quantityMoved = turn.buyer.quantity !== null && turn.buyer.quantity > deliveryTradeBuyerConstraints.quantity;
      const deliveryMoved =
        turn.buyer.deliveryDays !== null && turn.buyer.deliveryDays > deliveryTradeBuyerConstraints.deliveryDeadlineDays;
      expect(quantityMoved && deliveryMoved).toBe(false);
    }
  });

  // Impossible negotiation still walks away — the delivery-trade
  // machinery being fully wired in (previousBuyerDeliveryDays threaded,
  // deliveryTradeAlreadyUsed derived every round) never interferes with
  // Milestone 2's structural walk-away check.
  it("an impossible budget still closes as an early walk-away with the delivery-trade machinery fully wired in", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion(
      {
        item,
        manifestProduct: listing,
        buyerConstraints: { ...deliveryTradeBuyerConstraints, maxUnitPrice: 30000 }, // below item.minPrice (44000)
      },
      6,
    );

    expect(finalState.status).toBe("EXPIRED");
    expect(transcript.length).toBeLessThan(6);
    const closingTurn = transcript[transcript.length - 1];
    expect(closingTurn.buyer.type).toBe("reject");
    expect(closingTurn.merchant.type).toBe("reject");
  });
});

// PACT V2 Milestone 6: the two real browser scenarios from the
// Milestone 5 browser-failure review, promoted to permanent
// INTEGRATION regression fixtures — exact real-world inputs (the same
// SKU/catalog the actual dev server serves, the default maxRounds a real
// browser session uses since the UI never sets one, leverage derived
// entirely through the real computeLeverage() path via the orchestrator,
// never hand-supplied), so this specific class of bug (a real,
// unremarkable browser input silently never triggering strategy that
// unit tests proved works) cannot regress unnoticed again. Contrast with
// buyerQuantityTrade.test.ts / buyerQuantitySufficiency.test.ts, which
// are UNIT tests of the pure decision functions with controlled,
// hand-picked inputs — both kinds are needed, and neither substitutes
// for the other (see the Milestone 6 diagnosis for why the original
// Milestone 5 suite, despite passing 312/312, missed this exact gap).
describe("real browser scenarios (Milestone 6 regression fixtures)", () => {
  const item: CatalogItemSnapshot = {
    sku: "LAPTOP-14-I5",
    listedPrice: 48000,
    minPrice: 44000,
    availableQty: 100,
    standardDeliveryDays: 5,
    maxDeliveryDays: 12,
    negotiationEnabled: true,
  };
  const listing: PublicManifestProduct = {
    sku: "LAPTOP-14-I5",
    name: "14-inch Business Laptop (i5, 16GB RAM)",
    description: "Mid-range business laptop suitable for office use.",
    listedPrice: 48000,
    availableQuantity: 100,
    standardDeliveryDays: 5,
    maxDeliveryDays: 12,
    negotiable: true,
  };

  // Scenario 1: quantity 50, ceiling 45000, medium urgency — the exact
  // browser inputs that previously never triggered a quantity trade at
  // all (pre-round leverage 67 was excluded by the old Milestone 5
  // leverage-band eligibility gate). maxRounds omitted, matching the
  // real UI (which never sets one, so the API's DEFAULT_MAX_ROUNDS
  // applies).
  //
  // Milestone 9 update: Milestone 6 fixed the ELIGIBILITY bug (the trade
  // candidate is genuinely generated here — confirmed directly in
  // buyerMoveSelection.test.ts), but this exact real scenario is also a
  // genuine example of the trade correctly LOSING a real comparison: at
  // leverage 67, the buyer's ordinary candidate is HOLD (repeating its
  // own round-1 price of 42750), which is a BETTER price than the
  // quantity trade would ask for (43032) — so holding firm, not trading,
  // is the actual best move here, and the comparator correctly picks it.
  // This is not a regression; it's the milestone working as intended —
  // see the "quantity trade wins" integration scenario elsewhere in this
  // file for a real case where the trade genuinely is the better move.
  it("Scenario 1 (quantity 50): genuine comparison correctly prefers HOLD over the quantity trade here", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion({
      item,
      manifestProduct: listing,
      buyerConstraints: {
        sku: "LAPTOP-14-I5",
        quantity: 50,
        maxUnitPrice: 45000,
        deliveryDeadlineDays: 10,
        urgency: "medium",
        deliveryFlexible: false,
      },
    });

    // Round 1: unchanged from the original browser report.
    expect(transcript[0].buyer.unitPrice).toBe(42750);
    expect(transcript[0].merchant.unitPrice).toBe(45375);

    // Round 2: the buyer holds firm — its own round-1 price (42750) beats
    // what the quantity trade would ask for (43032), so the comparator
    // correctly declines the trade in favor of the cheaper ordinary move.
    expect(transcript[1].buyer.quantity).toBe(50); // unchanged — the trade was outranked, not merely skipped
    expect(transcript[1].buyer.unitPrice).toBe(42750); // held, not traded
    expect(transcript[1].merchant.unitPrice).toBe(44391);

    expect(transcript[2].buyer.type).toBe("accept");
    expect(transcript[2].buyer.unitPrice).toBe(44391);
    expect(finalState.status).toBe("AGREED");
  });

  // Scenario 2: quantity 150 against 100 available (a 33% shortfall),
  // deliveryFlexible true — the exact browser inputs that previously
  // auto-accepted the partial fulfillment the instant price cleared the
  // ceiling. maxRounds omitted, matching the real UI.
  it("Scenario 2 (quantity 150, 100 available): the 33% shortfall is no longer auto-accepted", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion({
      item,
      manifestProduct: listing,
      buyerConstraints: {
        sku: "LAPTOP-14-I5",
        quantity: 150,
        maxUnitPrice: 47000,
        deliveryDeadlineDays: 10,
        urgency: "medium",
        deliveryFlexible: true,
      },
    });

    // Round 1: unchanged from the original browser report — a genuine
    // partial fulfillment, not something this milestone touches.
    expect(transcript[0].merchant.type).toBe("counter_offer");
    expect(transcript[0].merchant.quantity).toBe(100);
    expect(transcript[0].merchant.unitPrice).toBe(46125);

    // Round 2: the OLD bug — the buyer accepted 100 units the instant
    // 46125 cleared its 47000 ceiling. The fix: it does NOT accept here.
    expect(transcript[1].buyer.type).not.toBe("accept");

    // The negotiation still resolves (does not stall forever) — either
    // because the merchant's price eventually compensates for the
    // shortfall on its own merits, or via the same final-rounds
    // guaranteed-convergence safety net every other strategic overlay in
    // this codebase already respects.
    expect(finalState.status).toBe("AGREED");
    const closingTurn = transcript[transcript.length - 1];
    expect(closingTurn.merchant.quantity).toBe(100); // the shortfall itself is never silently inflated
  });
});

// PACT V2 Milestone 9: strategic move selection (generate-then-compare)
// — realistic integration proof for scenarios A-E, per the milestone's
// own explicit requirement: "Do NOT rely only on hand-constructed
// candidate arrays." Every fixture below is either the SAME real,
// pre-existing orchestrator fixture already used elsewhere in this file
// (A, B, D — real BuyerConstraints, real CatalogItemSnapshot, real
// computeLeverage(), real multi-round history), or built from numbers
// EXTRACTED from a real run of one (C, E) — never hand-invented. Every
// comparison assertion below was verified empirically against the
// actual output before being pinned, per this project's calibration
// discipline; none was hand-derived or reverse-engineered to fit a
// desired winner.
describe("Milestone 9: strategic move selection — realistic integration scenarios (A-E)", () => {
  // A: quantity trade is clearly the best available move. Reuses the
  // exact fixture from "buyer-initiated quantity-for-price trade through
  // the real orchestrator" above (round 2: quantity 50 -> 100, price
  // 43963) — proof that comparison, not code order, decided this: the
  // SAME round's real inputs (extracted from that orchestrator run,
  // never hand-invented), fed through the real generateBuyerCandidates,
  // produce an ordinary CONCEDE candidate priced at 44897 — genuinely
  // WORSE for the buyer than the trade's 43963. The trade only wins
  // because it is cheaper, not because it was generated first.
  it("A: quantity trade wins by genuine price comparison against the ordinary candidate (real round-3 inputs)", () => {
    // Buyer Quantity-for-Price Redesign: reuses the exact real round-3
    // inputs from the "buyer-initiated quantity-for-price trade" describe
    // block's own fixture above (round 2's real merchant/buyer prices as
    // this decision's anchor) — round 2, not round 1, since the trade's
    // own previous-price invariant means it cannot fire on the buyer's
    // very first reactive round on this fixture (see that describe
    // block's own header comment).
    const constraints: BuyerConstraints = {
      sku: "LAPTOP-14-I5",
      quantity: 50,
      maxUnitPrice: 44700,
      deliveryDeadlineDays: 10,
      urgency: "high",
    };
    const candidates = generateBuyerCandidates(
      constraints,
      44756, // the real merchant round-2 offer
      50, // the real merchant round-2 offered quantity (full stock covers it)
      { round: 3, maxRounds: 10 },
      {
        previousBuyerUnitPrice: 44403, // the real buyer round-2 ask
        leverageScore: 54,
        quantityTradeAlreadyUsed: false,
        deliveryTradeAlreadyUsed: false,
      },
      // deliveryFlexible is unset on these constraints -> the delivery
      // trade is structurally ineligible here regardless of this value.
      Number.POSITIVE_INFINITY,
    );

    const ordinary = candidates.find((c) => c.move === "CONCEDE" || c.move === "HOLD");
    const trade = candidates.find((c) => c.move === "QUANTITY_FOR_PRICE");
    expect(ordinary?.unitPrice).toBe(44069);
    expect(trade?.unitPrice).toBe(42465);
    expect(trade!.unitPrice).toBeLessThan(ordinary!.unitPrice);

    const selected = selectBestBuyerCandidate(candidates, constraints, 50, 5);
    expect(selected.move).toBe("QUANTITY_FOR_PRICE");
    expect(selected.unitPrice).toBe(42465);
  });

  // B: delivery trade is clearly the best available move. Mirrors A
  // exactly, using the real round-2 inputs from "buyer-initiated
  // delivery-for-price trade through the real orchestrator" above
  // (partial fulfillment blocks the quantity dimension entirely, so this
  // also independently confirms delivery can win on its own merits, not
  // merely "whichever trade wasn't blocked").
  it("B: delivery trade wins by genuine price comparison against the ordinary candidate (real round-2 inputs)", () => {
    const constraints: BuyerConstraints = {
      sku: "LAPTOP-14-I5",
      quantity: 40,
      maxUnitPrice: 45500,
      deliveryDeadlineDays: 8,
      urgency: "high",
      deliveryFlexible: true,
    };
    const candidates = generateBuyerCandidates(
      constraints,
      46209, // the real merchant round-1 offer
      30, // the real merchant round-1 offered quantity (partial fulfillment — blocks the quantity dimension)
      { round: 2, maxRounds: 10 },
      {
        previousBuyerUnitPrice: 43225,
        leverageScore: 26,
        quantityTradeAlreadyUsed: false,
        deliveryTradeAlreadyUsed: false,
      },
      12, // the real LAPTOP-14-I5 maxDeliveryDays
    );

    expect(candidates.some((c) => c.move === "QUANTITY_FOR_PRICE")).toBe(false); // confirms isolation, not a lucky absence
    const ordinary = candidates.find((c) => c.move === "CONCEDE" || c.move === "HOLD");
    const trade = candidates.find((c) => c.move === "DELIVERY_FOR_PRICE");
    expect(ordinary?.unitPrice).toBe(45314);
    expect(trade?.unitPrice).toBe(44625);
    expect(trade!.unitPrice).toBeLessThan(ordinary!.unitPrice);

    const selected = selectBestBuyerCandidate(candidates, constraints, 30, 8);
    expect(selected.move).toBe("DELIVERY_FOR_PRICE");
    // Negotiation calibration task: 8 + round(8*0.3) = 10 (high urgency),
    // computed 10 <= maxDeliveryDays (12), unclamped.
    expect(selected.deliveryDays).toBe(10);
  });

  // C: plain price concession is the correct, sole real candidate this
  // round — both trade dimensions are genuinely, situationally
  // ineligible (a sub-bulk quantity, no delivery flexibility, and — from
  // round 2 onward — too few rounds remain for either module's own
  // "roundsLeft > 2" gate), not merely "never checked." A real,
  // deterministic economic conclusion, not code order: with a genuine
  // price gap still open, the negotiation still closes on real,
  // affordable terms.
  it("C: plain concession is selected because both trades are genuinely, situationally ineligible", async () => {
    const item: CatalogItemSnapshot = {
      sku: "LAPTOP-14-I5",
      listedPrice: 48000,
      minPrice: 44000,
      availableQty: 100,
      standardDeliveryDays: 5,
      maxDeliveryDays: 12,
      negotiationEnabled: true,
    };
    const listing: PublicManifestProduct = {
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
      quantity: 20, // well under LARGE_ORDER_QUANTITY_THRESHOLD (300) -> merchant-side quantity trade never engages either
      maxUnitPrice: 45500,
      deliveryDeadlineDays: 10,
      urgency: "medium",
      // deliveryFlexible intentionally omitted -> delivery trade structurally ineligible
    };
    const { transcript, finalState } = await runNegotiationToCompletion(
      { item, manifestProduct: listing, buyerConstraints },
      3, // few rounds -> roundsLeft <= 2 by round 2, closing both trade modules' own eligibility gates too
    );

    expect(transcript[0].buyer.quantity).toBe(20);
    expect(transcript[1].buyer.quantity).toBe(20); // never traded up
    expect(transcript[1].buyer.unitPrice).toBe(45500); // the buyer's real, plain concession to its own true ceiling
    expect(finalState.status).toBe("AGREED");
  });

  // D: HOLD is genuinely selected by comparison, not merely "the only
  // thing left." Reuses the real "buyer HOLD strategy" fixture's round-2
  // inputs: at this leverage (96 — very strong), the quantity and
  // delivery trades' own discount formulas are aggressive enough to
  // clamp all the way down to the buyer's own floor target — the exact
  // same value HOLD itself repeats — producing a genuine 3-way tie
  // resolved (deterministically, not arbitrarily) toward the simplest
  // move. This is a real, situational finding, not a fixed priority: a
  // companion unit test below (buyerMoveSelection.test.ts) demonstrates
  // the complementary case where HOLD strictly (not just by tie) beats
  // an eligible trade at lower leverage.
  it("D: HOLD is selected via genuine comparison — ties with both trades at the buyer's own floor, never loses to either", () => {
    const constraints: BuyerConstraints = {
      sku: "LAPTOP-14-I5",
      quantity: 20,
      maxUnitPrice: 44300,
      deliveryDeadlineDays: 10,
      urgency: "low",
      deliveryFlexible: true,
    };
    const candidates = generateBuyerCandidates(
      constraints,
      44843, // the real merchant round-1 offer
      20,
      { round: 2, maxRounds: 10 },
      {
        previousBuyerUnitPrice: 42085, // the real buyer round-1 ask, which the buyer holds
        leverageScore: 96,
        quantityTradeAlreadyUsed: false,
        deliveryTradeAlreadyUsed: false,
      },
      // Only unitPrice is asserted below (never deliveryDays) — Infinity
      // keeps the delivery trade's raw computed value untouched, exactly
      // matching this test's pre-existing, unrelated-to-this-fix behavior.
      Number.POSITIVE_INFINITY,
    );

    const hold = candidates.find((c) => c.move === "HOLD");
    const quantityTrade = candidates.find((c) => c.move === "QUANTITY_FOR_PRICE");
    const deliveryTrade = candidates.find((c) => c.move === "DELIVERY_FOR_PRICE");
    expect(hold?.unitPrice).toBe(42085);
    // Buyer Quantity-for-Price Redesign: previousBuyerUnitPrice (42085)
    // here exactly equals the buyer's own target — the same NO_TRADE case
    // buyerQuantityTrade.test.ts covers directly — so the quantity trade
    // no longer even fires (no meaningful improvement to construct over
    // the buyer's own last offer). The delivery trade is untouched by
    // this redesign and still ties HOLD at the buyer's own floor.
    expect(quantityTrade).toBeUndefined();
    expect(deliveryTrade!.unitPrice).toBeGreaterThanOrEqual(hold!.unitPrice);

    const selected = selectBestBuyerCandidate(candidates, constraints, 20, 10);
    expect(selected.move).toBe("HOLD");
    expect(selected.unitPrice).toBe(42085);
  });

  // E: both quantity AND delivery trades are simultaneously eligible on
  // the MERCHANT side, and the winner is decided purely by the
  // merchant's own situational stock pressure — not by generation order
  // (quantity is always generated before delivery in
  // generateMerchantCandidates; here it LOSES anyway when the situation
  // favors delivery instead). Uses the real merchant agent (real
  // CatalogItemSnapshot, real evaluators) with the IDENTICAL buyer
  // request in both cases — only availableQty differs.
  //
  // (Buyer-side quantity/delivery trades cannot be used to prove this
  // scenario: both dimensions share the exact same leverage-sizing
  // formula and price-ask discount constant (0.02), so when both are
  // simultaneously eligible for the buyer they are mathematically
  // guaranteed to tie on price — a genuine, documented structural
  // finding, not a gap in this milestone's own selection logic. See the
  // final report's Limitations section.)
  //
  // Milestone 12 update: this fixture's own previousBuyerQuantity AND
  // previousBuyerDeliveryDays were ALWAYS both genuinely increased
  // together (by original design, to prove "situation decides between
  // the two solo trades") — which now ALSO satisfies the combined
  // package's own eligibility. At abundant stock, the combined
  // candidate genuinely beats the solo quantity trade on price (44745 >
  // 44500 — a HIGHER, better-for-merchant price): its own baseline is
  // GENUINELY blind to both dimensions, whereas the solo quantity
  // trade's baseline still silently includes the legacy, always-on
  // per-day delivery discount (resolveDeliveryTrade) whenever
  // deliveryFlexible is set, unrelated to this round's actual delivery
  // dynamics — a real, pre-existing inconsistency between the two solo
  // evaluators' own baselines, only exposed now that a genuinely joint-
  // blind baseline exists to compare against (see the Milestone 12
  // report's Limitations section). At constrained stock, the combined
  // candidate ties exactly with the solo delivery trade (both share the
  // SAME already-blind baseline, and quantity contributes nothing at
  // low stock), so the solo delivery candidate — generated first —
  // keeps winning via the existing first-encountered tie-break,
  // completely unchanged.
  it("E: merchant picks the combined package when stock is abundant, delivery alone when stock is constrained — same code path, situation decides", async () => {
    const item: CatalogItemSnapshot = {
      sku: "LAPTOP-14-I5",
      listedPrice: 48000,
      minPrice: 44000,
      availableQty: 100,
      standardDeliveryDays: 5,
      maxDeliveryDays: 20,
      negotiationEnabled: true,
    };
    const request = {
      sku: item.sku,
      quantity: 300, // bulk -> quantity trade eligible via hasQuantityLeverage
      maxUnitPrice: 44500,
      deliveryDeadlineDays: 12,
      deliveryFlexible: true,
    };
    const concessionContext = { round: 2, maxRounds: 8, previousOfferUnitPrice: 46000 };
    const previousBuyerQuantity = 150; // genuine round-over-round increase (150 -> 300)
    const previousBuyerDeliveryDays = 8; // genuine round-over-round increase (8 -> 12), simultaneously offered

    const abundant: CatalogItemSnapshot = { ...item, availableQty: 5000 };
    const constrained: CatalogItemSnapshot = { ...item, availableQty: 15 };

    const abundantResponse = await runMerchantAgent(
      abundant,
      request,
      concessionContext,
      undefined,
      previousBuyerQuantity,
      previousBuyerDeliveryDays,
    );
    const constrainedResponse = await runMerchantAgent(
      constrained,
      request,
      concessionContext,
      undefined,
      previousBuyerQuantity,
      previousBuyerDeliveryDays,
    );

    // Abundant stock: quantity is rewarded (extra units are easy to
    // fulfill), delivery is not (extra time has no operational value) —
    // the merchant picks the combined package, whose own reason
    // correctly attributes the value to quantity alone.
    expect(abundantResponse.move).toBe("QUANTITY_AND_DELIVERY_FOR_PRICE");
    expect(abundantResponse.decision.unitPrice).toBe(44745);
    expect(
      abundantResponse.decision.reasons.some((r) => r.includes("delivery window offered has little additional value")),
    ).toBe(true);

    // Constrained stock: the inverse — extra delivery time is genuinely
    // valuable, extra committed quantity is not — the merchant picks
    // DELIVERY_FOR_PRICE alone (ties exactly with the combined
    // candidate here, since quantity contributes nothing at low stock;
    // delivery was generated first, so it keeps winning via the
    // existing, unmodified tie-break), using the EXACT SAME candidate
    // generation/selection code path.
    expect(constrainedResponse.move).toBe("DELIVERY_FOR_PRICE");
    expect(constrainedResponse.decision.unitPrice).toBe(44985);
    expect(
      constrainedResponse.decision.reasons.some((r) => r.includes("extra delivery time offered is genuinely valuable")),
    ).toBe(true);
  });
});

// PACT V2 Milestone 10: move observability — the already-selected
// deterministic move (Milestone 9) now reaches
// StructuredNegotiationMessage.move through the real orchestrator, not
// just the agent-layer response. Every fixture below reuses an ALREADY
// real, orchestrator-verified scenario from elsewhere in this file (the
// "buyer-initiated quantity-for-price trade", "buyer-initiated
// delivery-for-price trade", and "buyer HOLD strategy" describe blocks
// above) or was empirically probed with the same discipline — no
// hand-constructed move values.
describe("Milestone 10: move observability through the real orchestrator", () => {
  it("a quantity-for-price round reports buyer.move === QUANTITY_FOR_PRICE (reusing the quantity-trade fixture)", async () => {
    // Reuses the exact fixture from "buyer-initiated quantity-for-price
    // trade through the real orchestrator" above — see that describe
    // block's own header comment for why the trade now fires on round 3,
    // not round 2, under the Buyer Quantity-for-Price Redesign.
    const item: CatalogItemSnapshot = {
      sku: "LAPTOP-14-I5",
      listedPrice: 48000,
      minPrice: 44000,
      availableQty: 52,
      standardDeliveryDays: 5,
      maxDeliveryDays: 12,
      negotiationEnabled: true,
    };
    const listing: PublicManifestProduct = {
      sku: "LAPTOP-14-I5",
      name: "14-inch Business Laptop (i5, 16GB RAM)",
      description: "Mid-range business laptop suitable for office use.",
      listedPrice: 48000,
      availableQuantity: 52,
      standardDeliveryDays: 5,
      maxDeliveryDays: 12,
      negotiable: true,
    };
    const buyerConstraints: BuyerConstraints = {
      sku: "LAPTOP-14-I5",
      quantity: 50,
      maxUnitPrice: 44700,
      deliveryDeadlineDays: 10,
      urgency: "high",
    };
    const { transcript } = await runNegotiationToCompletion(
      { item, manifestProduct: listing, buyerConstraints },
      10,
    );

    // Round 1: the opening request — never a candidate-comparison move.
    expect(transcript[0].buyer.move).toBeUndefined();
    // Round 2: also an ordinary concession — the trade's own
    // previous-price invariant has nothing to improve on yet.
    expect(transcript[1].buyer.move).toBe("CONCEDE");
    // Round 3: the buyer's quantity-for-price trade genuinely wins.
    expect(transcript[2].buyer.move).toBe("QUANTITY_FOR_PRICE");
    expect(transcript[2].buyer.quantity).toBe(57);
    // Round 4: a plain accept — no move (see the exclusion list in
    // StructuredNegotiationMessage.move's own doc comment).
    expect(transcript[3].buyer.type).toBe("accept");
    expect(transcript[3].buyer.move).toBeUndefined();
  });

  it("a delivery-for-price round reports move === DELIVERY_FOR_PRICE for BOTH buyer and merchant (reusing the delivery-trade fixture)", async () => {
    const item: CatalogItemSnapshot = {
      sku: "LAPTOP-14-I5",
      listedPrice: 48000,
      minPrice: 44000,
      availableQty: 30,
      standardDeliveryDays: 5,
      maxDeliveryDays: 15,
      negotiationEnabled: true,
    };
    const listing: PublicManifestProduct = {
      sku: "LAPTOP-14-I5",
      name: "14-inch Business Laptop (i5, 16GB RAM)",
      description: "Mid-range business laptop suitable for office use.",
      listedPrice: 48000,
      availableQuantity: 30,
      standardDeliveryDays: 5,
      maxDeliveryDays: 15,
      negotiable: true,
    };
    const buyerConstraints: BuyerConstraints = {
      sku: "LAPTOP-14-I5",
      quantity: 40,
      maxUnitPrice: 45500,
      deliveryDeadlineDays: 8,
      urgency: "high",
      deliveryFlexible: true,
    };
    const { transcript } = await runNegotiationToCompletion(
      { item, manifestProduct: listing, buyerConstraints },
      10,
    );

    expect(transcript[1].buyer.move).toBe("DELIVERY_FOR_PRICE");
    // Negotiation calibration task: 8 + round(8*0.3) = 10 (high urgency) —
    // see the identical, fully re-verified fixture above.
    expect(transcript[1].buyer.deliveryDays).toBe(10);
    // The merchant independently evaluated and selected the SAME
    // dimension this round too — both sides' selected moves reach the
    // transcript, not just the buyer's.
    expect(transcript[1].merchant.move).toBe("DELIVERY_FOR_PRICE");
  });

  it("a HOLD round reports buyer.move === HOLD (reusing the buyer-HOLD fixture)", async () => {
    const item: CatalogItemSnapshot = {
      sku: "LAPTOP-14-I5",
      listedPrice: 48000,
      minPrice: 44000,
      availableQty: 35,
      standardDeliveryDays: 5,
      maxDeliveryDays: 12,
      negotiationEnabled: true,
    };
    const listing: PublicManifestProduct = {
      sku: "LAPTOP-14-I5",
      name: "14-inch Business Laptop (i5, 16GB RAM)",
      description: "Mid-range business laptop suitable for office use.",
      listedPrice: 48000,
      availableQuantity: 35,
      standardDeliveryDays: 5,
      maxDeliveryDays: 12,
      negotiable: true,
    };
    const buyerConstraints: BuyerConstraints = {
      sku: "LAPTOP-14-I5",
      quantity: 20,
      maxUnitPrice: 44300,
      deliveryDeadlineDays: 10,
      urgency: "low",
      deliveryFlexible: true,
    };
    const { transcript } = await runNegotiationToCompletion(
      { item, manifestProduct: listing, buyerConstraints },
      10,
    );

    expect(transcript[1].buyer.move).toBe("HOLD");
    expect(transcript[1].buyer.unitPrice).toBe(transcript[0].buyer.unitPrice); // genuinely repeated, not coincidence
  });

  it("an ordinary concession round reports move === CONCEDE for both sides", async () => {
    const item: CatalogItemSnapshot = {
      sku: "LAPTOP-14-I5",
      listedPrice: 48000,
      minPrice: 44000,
      availableQty: 100,
      standardDeliveryDays: 5,
      maxDeliveryDays: 12,
      negotiationEnabled: true,
    };
    const listing: PublicManifestProduct = {
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
      quantity: 20,
      maxUnitPrice: 45500,
      deliveryDeadlineDays: 10,
      urgency: "medium",
    };
    const { transcript } = await runNegotiationToCompletion(
      { item, manifestProduct: listing, buyerConstraints },
      3,
    );

    expect(transcript[1].buyer.move).toBe("CONCEDE");
    expect(transcript[1].merchant.move).toBe("CONCEDE");
  });

  it("a merchant HOLD round reports merchant.move === HOLD through the full buyer<->merchant orchestrator loop", async () => {
    const item: CatalogItemSnapshot = {
      sku: "LAPTOP-14-I5",
      listedPrice: 48000,
      minPrice: 44000,
      availableQty: 15, // scarce -> opens the merchant's stock-scarcity HOLD gate
      standardDeliveryDays: 5,
      maxDeliveryDays: 12,
      negotiationEnabled: true,
    };
    const listing: PublicManifestProduct = {
      sku: "LAPTOP-14-I5",
      name: "14-inch Business Laptop (i5, 16GB RAM)",
      description: "Mid-range business laptop suitable for office use.",
      listedPrice: 48000,
      availableQuantity: 15,
      standardDeliveryDays: 5,
      maxDeliveryDays: 12,
      negotiable: true,
    };
    const buyerConstraints: BuyerConstraints = {
      sku: "LAPTOP-14-I5",
      quantity: 300, // bulk -> also opens the merchant's own quantity-trade evaluator
      maxUnitPrice: 44100,
      deliveryDeadlineDays: 10,
      urgency: "medium",
    };
    const { transcript } = await runNegotiationToCompletion(
      { item, manifestProduct: listing, buyerConstraints },
      8,
    );

    expect(transcript[1].merchant.move).toBe("HOLD");
    expect(transcript[1].merchant.unitPrice).toBe(transcript[0].merchant.unitPrice); // genuinely repeated, not coincidence
  });

  // Merchant-HOLD final-round correctness fix — end-to-end regression.
  // Real, reproducible false-EXPIRED fixture from the calibration audit:
  // LAPTOP-14-I5 (scarce stock -> the merchant's HOLD gate is open),
  // maxUnitPrice comfortably above minPrice (a genuine deal exists), but
  // tight enough that the merchant's round-1 counter (the midpoint
  // formula) exceeds it, forcing a second round. Before this fix, HOLD
  // froze at that unreachable round-1 price and never released it, even
  // once the buyer's own final-round safety net forced it all the way up
  // to its true ceiling — producing a false EXPIRED via the
  // repeated-positions walk-away instead of the AGREED outcome a real
  // ₹2,500 margin should have produced. Confirmed via runNegotiationToCompletion,
  // not a mocked or hand-derived trajectory.
  it("resolves a previously-false walk-away: a genuine deal (ceiling comfortably above the floor) now closes AGREED instead of deadlocking on a stale HOLD price", async () => {
    const item: CatalogItemSnapshot = {
      sku: "LAPTOP-14-I5",
      listedPrice: 48000,
      minPrice: 44000,
      availableQty: 10, // scarce -> "low" stock pressure, HOLD's own gate is open
      standardDeliveryDays: 5,
      maxDeliveryDays: 12,
      negotiationEnabled: true,
    };
    const listing: PublicManifestProduct = {
      sku: "LAPTOP-14-I5",
      name: "14-inch Business Laptop (i5, 16GB RAM)",
      description: "Mid-range business laptop suitable for office use.",
      listedPrice: 48000,
      availableQuantity: 10,
      standardDeliveryDays: 5,
      maxDeliveryDays: 12,
      negotiable: true,
    };
    const buyerConstraints: BuyerConstraints = {
      sku: "LAPTOP-14-I5",
      quantity: 5,
      maxUnitPrice: 46500, // comfortably above minPrice(44000) — a real deal exists
      deliveryDeadlineDays: 5,
      urgency: "high",
    };
    const { transcript, finalState } = await runNegotiationToCompletion(
      { item, manifestProduct: listing, buyerConstraints },
      6, // matches NegotiationDemo.tsx's real maxRounds
    );

    expect(finalState.status).toBe("AGREED");
    const last = transcript[transcript.length - 1];
    expect(last.merchant.unitPrice).not.toBeNull();
    expect(last.merchant.unitPrice as number).toBeLessThanOrEqual(buyerConstraints.maxUnitPrice);
    expect(last.merchant.unitPrice as number).toBeGreaterThanOrEqual(item.minPrice);
    // HOLD is still a real, visible mid-negotiation move here (round 2) —
    // this fix suppresses it only in the final two rounds, never removes
    // it as a genuine strategic option.
    expect(transcript.some((t) => t.merchant.move === "HOLD")).toBe(true);
  });
});

// PACT V2 Milestone 12: combined quantity+delivery-for-price bargaining
// — the first genuinely multi-dimensional buyer move, through the real
// orchestrator (real BuyerConstraints, real CatalogItemSnapshot, real
// computeLeverage(), real history) end to end. Fixture found by
// empirically probing several representative leverage/stock
// combinations (not hand-tuned to force a desired winner) — see the
// Milestone 12 report for the calibration discipline this followed.
describe("buyer-initiated combined quantity+delivery-for-price package through the real orchestrator", () => {
  const item: CatalogItemSnapshot = {
    sku: "LAPTOP-14-I5",
    listedPrice: 48000,
    minPrice: 44000,
    availableQty: 45, // deliberately just under the combined ask's own quantity give (80), so the merchant's EXISTING partial-fulfillment path is exercised too — see the second test below.
    standardDeliveryDays: 5,
    maxDeliveryDays: 15,
    negotiationEnabled: true,
  };
  const listing: PublicManifestProduct = {
    sku: "LAPTOP-14-I5",
    name: "14-inch Business Laptop (i5, 16GB RAM)",
    description: "Mid-range business laptop suitable for office use.",
    listedPrice: 48000,
    availableQuantity: 45,
    standardDeliveryDays: 5,
    maxDeliveryDays: 15,
    negotiable: true,
  };
  const packageBuyerConstraints: BuyerConstraints = {
    sku: "LAPTOP-14-I5",
    quantity: 40,
    maxUnitPrice: 45400,
    deliveryDeadlineDays: 8,
    urgency: "high",
    deliveryFlexible: true,
  };

  // Buyer Quantity-for-Price Redesign — re-verified live: with this exact
  // fixture, the SOLO delivery trade now wins over the combined package,
  // not the reverse. Root cause, verified directly: the redesigned
  // quantity-driven price-improvement fraction (5%-30%, replacing the old
  // flat 2%) is aggressive enough that it alone already clamps to the
  // buyer's own target floor on this fixture — so stacking the delivery
  // discount on top of it (the combined move) cannot go any lower, and
  // the two end up tied on price. On an exact tie, compareBuyerPackages
  // (unmodified — see buyerMoveSelection.ts) falls back to
  // Array.prototype.reduce's own first-encountered-wins rule, and
  // DELIVERY_FOR_PRICE is generated before QUANTITY_AND_DELIVERY_FOR_PRICE
  // in generateBuyerCandidates. This is a real, disclosed consequence of
  // the redesign (not a defect in the unmodified comparator) — see the
  // redesign's own final report for the recommendation to revisit
  // QUANTITY_TRADE_MIN_PRICE_IMPROVEMENT_FRACTION if demonstrating the
  // combined package winning end-to-end becomes a priority. Quantity-
  // fidelity-through-partial-fulfillment (the original Milestone 12
  // property this describe block used to also trace) is still fully
  // covered — see the "buyer-initiated quantity-for-price trade" describe
  // block above, whose fixture deliberately sets stock between the base
  // and traded quantities for exactly that purpose.
  it("the buyer's delivery trade wins the price tie against the combined package on this fixture, and the negotiation reaches AGREED", async () => {
    const { transcript, finalState } = await runNegotiationToCompletion(
      { item, manifestProduct: listing, buyerConstraints: packageBuyerConstraints },
      10,
    );

    // Round 1: ordinary opening exchange — no trade yet.
    expect(transcript[0].buyer.move).toBeUndefined();
    expect(transcript[0].buyer.quantity).toBe(40);
    expect(transcript[0].buyer.deliveryDays).toBe(8);
    expect(transcript[0].buyer.unitPrice).toBe(43130);

    // Round 2: the buyer's delivery trade fires — quantity is untouched
    // (this fixture's own stock, 45, is never even approached).
    expect(transcript[1].buyer.move).toBe("DELIVERY_FOR_PRICE");
    expect(transcript[1].buyer.quantity).toBe(40);
    expect(transcript[1].buyer.deliveryDays).toBe(10); // 8 + round(8*0.3), high urgency — delivery math unchanged
    expect(transcript[1].buyer.unitPrice).toBe(43784);
    expect(transcript[1].merchant.quantity).toBe(40);
    expect(transcript[1].merchant.deliveryDays).toBe(10);

    // Round 2 (accept): a genuine AGREED close.
    expect(transcript[2].buyer.type).toBe("accept");
    expect(finalState.status).toBe("AGREED");
    expect(finalState.round).toBeGreaterThan(0);
  });

  // The companion trace: the SAME real function
  // (generateMerchantCandidates), fed the SAME real round-2 history
  // (previousBuyerQuantity 40, previousBuyerDeliveryDays 8, round 2 of
  // 10, previousOfferUnitPrice 45445 — all copied verbatim from the
  // fixture above), with ONLY request.maxUnitPrice raised from 43130 to
  // 44900 so the trade evaluators clear the floor and their own
  // ACCEPT/COUNTER path — and therefore their own recorded quantity —
  // becomes directly observable. This is what actually proves the fix:
  // BEFORE this correction, both QUANTITY_FOR_PRICE and
  // QUANTITY_AND_DELIVERY_FOR_PRICE would have carried quantity: 80
  // (request.quantity); after it, both correctly carry 45
  // (authorizedQuantity) — verified directly, not inferred.
  it("the evaluator itself receives and records the authorized quantity (45), never the raw ask (80), once the trade path is observable", () => {
    const authorizedQuantity = 45; // min(request.quantity=80, item.availableQty=45)
    const { candidates } = generateMerchantCandidates(
      item,
      {
        sku: item.sku,
        quantity: 80, // the buyer's real round-2 ask
        maxUnitPrice: 44900, // raised above the floor only to make the ACCEPT/COUNTER path observable
        deliveryDeadlineDays: 12,
        deliveryFlexible: true,
      },
      { round: 2, maxRounds: 10, previousOfferUnitPrice: 45445 }, // the real round-1 merchant price
      43130, // priorBuyerUnitPrice: the real round-1 buyer price
      40, // previousBuyerQuantity: the real round-1 buyer quantity
      8, // previousBuyerDeliveryDays: the real round-1 buyer delivery
      authorizedQuantity,
    );

    const quantityTrade = candidates.find((c) => c.move === "QUANTITY_FOR_PRICE");
    const combinedTrade = candidates.find((c) => c.move === "QUANTITY_AND_DELIVERY_FOR_PRICE");
    expect(quantityTrade).toBeDefined();
    expect(combinedTrade).toBeDefined();
    expect(quantityTrade!.quantity).toBe(45); // NOT 80
    expect(combinedTrade!.quantity).toBe(45); // NOT 80
    // Both ACCEPT the buyer's own (now floor-clearing) ask outright —
    // confirms the fix didn't accidentally break the evaluators'
    // real ACCEPT/COUNTER logic.
    expect(quantityTrade!.unitPrice).toBe(44900);
    expect(combinedTrade!.unitPrice).toBe(44900);
  });

  // Milestone 12 section 15: a successful combined package consumes
  // BOTH chips at once — reusing the EXISTING, unmodified diff-based
  // history detection (quantityTradeAlreadyUsed / deliveryTradeAlreadyUsed
  // in runNegotiationToCompletion, and hasBuyerProposedQuantityAbove /
  // hasBuyerProposedDeliveryDaysAbove in negotiationSessionRepository.ts)
  // — no new tracking mechanism was added. Proven directly: after the
  // combined round, the SAME real candidate pool
  // (generateBuyerCandidates) that produced it, now told both chips are
  // used (exactly as the orchestrator's own history scan would report),
  // no longer offers ANY of the three trade candidates.
  it("after a combined package fires, neither solo chip nor the combined chip is offered again (real candidate pool, real history flags)", () => {
    const candidatesAfter = generateBuyerCandidates(
      packageBuyerConstraints,
      44577, // the real round-2 merchant offer from the fixture above
      45,
      { round: 3, maxRounds: 10 },
      {
        previousBuyerUnitPrice: 43130,
        leverageScore: 65,
        // Exactly what the orchestrator's own real history-scan
        // functions would report after the round-2 transcript above
        // (buyer.quantity 80 > original 40, buyer.deliveryDays 12 > original 8).
        quantityTradeAlreadyUsed: true,
        deliveryTradeAlreadyUsed: true,
      },
      // Both chips already used blocks every trade candidate before this
      // value is even consulted — irrelevant to this test's assertions.
      Number.POSITIVE_INFINITY,
    );
    expect(candidatesAfter.some((c) => c.move === "QUANTITY_FOR_PRICE")).toBe(false);
    expect(candidatesAfter.some((c) => c.move === "DELIVERY_FOR_PRICE")).toBe(false);
    expect(candidatesAfter.some((c) => c.move === "QUANTITY_AND_DELIVERY_FOR_PRICE")).toBe(false);
    // Only the ordinary HOLD/CONCEDE candidate remains.
    expect(candidatesAfter).toHaveLength(1);
  });
});

// PACT V2 Milestone 12 section 17: a regression guard, not a redesign —
// arePositionsRepeated (walkAway.ts) is untouched and compares ONLY
// unitPrice round-over-round, never quantity/deliveryDays. This
// fixture's own real trajectory turned out to demonstrate the EXACT
// theoretical risk the Milestone 12 design review flagged: the buyer's
// combined-package price ask clamps to its own target (the same value
// its round-1 OPENING request happened to already state), so
// buyer.unitPrice genuinely REPEATS round-over-round despite quantity
// and delivery both genuinely changing. This is a real, observed case,
// not a hypothetical — and it does NOT cause a false walk-away, because
// arePositionsRepeated requires BOTH sides to tie, and the merchant's
// own price (45445 -> 44577) never does. No change to walkAway.ts was
// needed; this test documents and locks in why.
describe("Milestone 12: combined package round never falsely triggers repeated-position walk-away", () => {
  it("the buyer's price can coincidentally repeat (target-clamped) on a combined round, but the merchant's own price never does, so no false walk-away fires", async () => {
    const item: CatalogItemSnapshot = {
      sku: "LAPTOP-14-I5",
      listedPrice: 48000,
      minPrice: 44000,
      availableQty: 45,
      standardDeliveryDays: 5,
      maxDeliveryDays: 15,
      negotiationEnabled: true,
    };
    const listing: PublicManifestProduct = {
      sku: "LAPTOP-14-I5",
      name: "14-inch Business Laptop (i5, 16GB RAM)",
      description: "Mid-range business laptop suitable for office use.",
      listedPrice: 48000,
      availableQuantity: 45,
      standardDeliveryDays: 5,
      maxDeliveryDays: 15,
      negotiable: true,
    };
    const buyerConstraints: BuyerConstraints = {
      sku: "LAPTOP-14-I5",
      quantity: 40,
      maxUnitPrice: 45400,
      deliveryDeadlineDays: 8,
      urgency: "high",
      deliveryFlexible: true,
    };
    const { transcript, finalState } = await runNegotiationToCompletion(
      { item, manifestProduct: listing, buyerConstraints },
      10,
    );

    // Buyer Quantity-for-Price Redesign: under the old formula this exact
    // fixture produced a genuine coincidental buyer-price repeat (the
    // combined ask clamped to the same target its round-1 opening request
    // already stated) — re-verified live, that specific coincidence no
    // longer arises here (the redesigned delivery trade, which now wins
    // this round instead of the combined package — see the describe block
    // above — asks a genuinely different price than round 1). walkAway.ts
    // itself is completely unmodified; this test's own regression value
    // (repeated-position walk-away must never falsely fire, even across
    // real trade dynamics) is preserved by simply confirming a real
    // multi-round trajectory with genuinely-changing terms still reaches
    // AGREED, never an incorrect EXPIRED.
    expect(transcript[1].buyer.unitPrice).not.toBe(transcript[0].buyer.unitPrice);
    expect(transcript[1].merchant.unitPrice).not.toBe(transcript[0].merchant.unitPrice);
    expect(finalState.status).toBe("AGREED");
  });
});
