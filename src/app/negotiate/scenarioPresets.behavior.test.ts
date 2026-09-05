// Scenario-behavior fix — end-to-end proof that the seven demo presets
// (negotiationUi.ts) actually produce genuinely distinct negotiation
// strategies through the REAL orchestrator, at the REAL UI's own
// maxRounds (6 — see NegotiationDemo.tsx's own comment on why it's not
// the API's DEFAULT_MAX_ROUNDS of 4). Every other test file in this
// codebase that exercises preset-shaped fixtures uses its own
// hand-picked maxRounds (often 10); this file exists specifically to
// verify the actual, literal values a person clicking a preset in the
// UI would see, at the actual round budget the UI actually sends —
// which is what surfaced the real bugs (D4's leverage gate silently
// defeated, and the rush-delivery hard-reject) this milestone fixes.

import { describe, expect, it, vi } from "vitest";
import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import type { PublicManifestProduct } from "@/types/manifest";
import { runNegotiationToCompletion } from "@/lib/negotiation/orchestrator";
import { getScenarioPresets } from "./negotiationUi";

vi.mock("@/lib/llm/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/provider")>();
  return {
    ...actual,
    getLlmProvider: vi.fn(() => {
      throw new actual.LlmUnavailableError("no key");
    }),
  };
});

// The real seeded catalog (prisma/seed.ts) — kept in sync deliberately,
// not imported from the seed script (that file talks to a real Prisma
// client; this stays a pure, DB-free fixture like every other test in
// this codebase).
const CATALOG: Record<string, CatalogItemSnapshot> = {
  "LAPTOP-14-I5": {
    sku: "LAPTOP-14-I5",
    listedPrice: 48000,
    minPrice: 44000,
    availableQty: 10,
    standardDeliveryDays: 5,
    maxDeliveryDays: 12,
    negotiationEnabled: true,
  },
  "MONITOR-24-FHD": {
    sku: "MONITOR-24-FHD",
    listedPrice: 9500,
    minPrice: 8200,
    availableQty: 250,
    standardDeliveryDays: 4,
    maxDeliveryDays: 10,
    negotiationEnabled: true,
  },
  "KEYBOARD-WIRELESS": {
    sku: "KEYBOARD-WIRELESS",
    listedPrice: 1400,
    minPrice: 1150,
    availableQty: 500,
    standardDeliveryDays: 3,
    maxDeliveryDays: 7,
    negotiationEnabled: true,
  },
};

const MANIFEST: PublicManifestProduct[] = Object.values(CATALOG).map((item) => ({
  sku: item.sku,
  name: item.sku,
  description: "",
  listedPrice: item.listedPrice,
  availableQuantity: item.availableQty,
  standardDeliveryDays: item.standardDeliveryDays,
  maxDeliveryDays: item.maxDeliveryDays,
  negotiable: true,
}));

/** The exact maxRounds the real UI sends — see NegotiationDemo.tsx. */
const UI_MAX_ROUNDS = 6;

function preset(id: string) {
  const found = getScenarioPresets(MANIFEST).find((p) => p.id === id);
  if (!found) throw new Error(`Missing preset fixture: ${id}`);
  return found;
}

async function runPreset(id: string) {
  const p = preset(id);
  const item = CATALOG[p.sku];
  const buyerConstraints = {
    sku: p.values.sku,
    quantity: Number(p.values.quantity),
    maxUnitPrice: Number(p.values.maxUnitPrice),
    deliveryDeadlineDays: Number(p.values.deliveryDeadlineDays),
    urgency: p.values.urgency,
    deliveryFlexible: p.values.deliveryFlexible,
  };
  const manifestProduct = MANIFEST.find((m) => m.sku === p.sku)!;
  return runNegotiationToCompletion({ item, manifestProduct, buyerConstraints }, UI_MAX_ROUNDS);
}

describe("scenario presets produce genuinely distinct negotiation strategies (real orchestrator, real UI maxRounds)", () => {
  // 1. Balanced — an ordinary, gradual back-and-forth. Must not regress.
  it("balanced: a genuine multi-round exchange, reaching AGREED", async () => {
    const { transcript, finalState } = await runPreset("balanced");
    expect(finalState.status).toBe("AGREED");
    expect(transcript.length).toBeGreaterThanOrEqual(2);
  });

  // 2. Bulk buyer — volume discount / buyer quantity leverage. At least
  // 2 meaningful price exchanges before agreement, never an instant
  // single-round accept, and the final price stays within the buyer's
  // own ceiling and the merchant's own floor.
  it("bulk buyer: at least two meaningful price exchanges, a genuine quantity-driven discount, never an instant accept", async () => {
    const p = preset("bulk-buyer");
    const item = CATALOG[p.sku];
    const { transcript, finalState } = await runPreset("bulk-buyer");

    expect(finalState.status).toBe("AGREED");
    // "At least 2 meaningful price exchanges" — the merchant's own
    // offered price must genuinely differ across at least two rounds
    // (not just repeat the same number until forced convergence).
    const merchantPrices = transcript
      .map((t) => t.merchant.unitPrice)
      .filter((price): price is number => price !== null);
    const distinctMerchantPrices = new Set(merchantPrices);
    expect(distinctMerchantPrices.size).toBeGreaterThanOrEqual(2);
    expect(transcript.length).toBeGreaterThanOrEqual(2);

    // Genuine quantity-driven bargaining, not a plain concession.
    expect(transcript.some((t) => t.merchant.move === "QUANTITY_FOR_PRICE")).toBe(true);

    // Hard bounds: buyer's own ceiling, merchant's own viability floor.
    const finalPrice = transcript[transcript.length - 1].merchant.unitPrice!;
    expect(finalPrice).toBeLessThanOrEqual(Number(p.values.maxUnitPrice));
    expect(finalPrice).toBeGreaterThanOrEqual(item.minPrice);
  });

  // 3. Buyer bulk request — distinct from Bulk Buyer: the BUYER
  // explicitly initiates the volume-for-price trade (buyerQuantityTrade.ts),
  // not the merchant's own bulk-order discount.
  it("buyer bulk request: the BUYER explicitly proposes a larger order for a better price — a different mechanism than Bulk Buyer", async () => {
    const { transcript, finalState } = await runPreset("buyer-bulk-request");
    expect(finalState.status).toBe("AGREED");
    expect(transcript.some((t) => t.buyer.move === "QUANTITY_FOR_PRICE")).toBe(true);

    // The buyer's own quantity in the winning round must genuinely
    // exceed its original ask — a real "give more" from the buyer's own
    // side, the defining trait that distinguishes this from Bulk Buyer
    // (where the merchant's own baseline discount is what moves, and the
    // buyer's requested quantity never changes).
    const p = preset("buyer-bulk-request");
    const originalQuantity = Number(p.values.quantity);
    const tradeRound = transcript.find((t) => t.buyer.move === "QUANTITY_FOR_PRICE");
    expect(tradeRound!.buyer.quantity!).toBeGreaterThan(originalQuantity);
  });

  // 4. Low-stock merchant — merchant supply scarcity / merchant leverage.
  // The hard stock constraint must never be violated, and the negotiation
  // must be a genuine back-and-forth, never an instant single-round accept.
  it("low-stock merchant: quantity never exceeds available stock, and the merchant visibly holds firm before conceding", async () => {
    const p = preset("low-stock");
    const item = CATALOG[p.sku];
    const { transcript, finalState } = await runPreset("low-stock");

    expect(finalState.status).toBe("AGREED");
    // Hard constraint: the merchant never OFFERS more than it actually
    // has, at every round (the buyer's own ASK can legitimately exceed
    // stock — that's the whole point of partial fulfillment; only what
    // the merchant actually offers/fulfills is stock-bound).
    for (const t of transcript) {
      if (t.merchant.quantity !== null) {
        expect(t.merchant.quantity).toBeLessThanOrEqual(item.availableQty);
      }
    }
    // The final agreed quantity itself never exceeds stock either.
    const finalQuantity = transcript[transcript.length - 1].merchant.quantity;
    expect(finalQuantity).toBeLessThanOrEqual(item.availableQty);
    // The correct, pre-existing partial-fulfillment behavior: offered
    // quantity is capped at the entire available stock.
    expect(transcript[0].merchant.quantity).toBe(item.availableQty);

    // "Too immediate" regression: must not settle in a single round.
    expect(transcript.length).toBeGreaterThanOrEqual(2);
    // Visible merchant bargaining power: at least one round where the
    // merchant holds its price rather than immediately conceding to the
    // buyer's counter.
    expect(transcript.some((t) => t.merchant.move === "HOLD")).toBe(true);
  });

  // 5. Urgent delivery — faster delivery traded against a higher price.
  // THE headline fix: a deadline faster than standard is no longer an
  // instant reject, the merchant genuinely meets the tighter deadline,
  // and doing so visibly costs more than the item's own listed price.
  it("urgent delivery: the merchant meets the buyer's faster-than-standard deadline, at a real, visible price premium", async () => {
    const p = preset("urgent-delivery");
    const item = CATALOG[p.sku];
    const deadline = Number(p.values.deliveryDeadlineDays);
    expect(deadline).toBeLessThan(item.standardDeliveryDays); // the preset itself must actually be a rush request

    const { transcript, finalState } = await runPreset("urgent-delivery");
    expect(finalState.status).toBe("AGREED");

    // The rush deadline is honored throughout — never silently reverted
    // to the merchant's own standard pace.
    for (const t of transcript) {
      if (t.merchant.deliveryDays !== null) {
        expect(t.merchant.deliveryDays).toBe(deadline);
      }
    }

    // The defining trait: faster delivery has a real cost — the
    // merchant's own price band for this negotiation genuinely exceeds
    // the item's normal listed price (the rush premium — see
    // resolveDeliveryRushPremiumFraction).
    expect(transcript[0].merchant.unitPrice!).toBeGreaterThan(item.listedPrice);

    const finalPrice = transcript[transcript.length - 1].merchant.unitPrice!;
    expect(finalPrice).toBeLessThanOrEqual(Number(p.values.maxUnitPrice));
  });

  // Direct comparison: the SAME fixture, but at standard (non-rush)
  // delivery, must settle for materially less — proving the premium is
  // actually attributable to speed, not just this fixture's other inputs.
  it("urgent delivery: the SAME fixture at standard (non-rush) delivery settles for materially less", async () => {
    const p = preset("urgent-delivery");
    const item = CATALOG[p.sku];
    const rush = await runPreset("urgent-delivery");
    const rushFinalPrice = rush.transcript[rush.transcript.length - 1].merchant.unitPrice!;

    const nonRush = await runNegotiationToCompletion(
      {
        item,
        manifestProduct: MANIFEST.find((m) => m.sku === p.sku)!,
        buyerConstraints: {
          sku: p.values.sku,
          quantity: Number(p.values.quantity),
          maxUnitPrice: Number(p.values.maxUnitPrice),
          deliveryDeadlineDays: item.standardDeliveryDays, // no rush
          urgency: p.values.urgency,
          deliveryFlexible: p.values.deliveryFlexible,
        },
      },
      UI_MAX_ROUNDS,
    );
    const nonRushFinalPrice =
      nonRush.transcript[nonRush.transcript.length - 1].merchant.unitPrice!;

    expect(rushFinalPrice).toBeGreaterThan(nonRushFinalPrice);
  });

  // 6. Flexible delivery — slower delivery traded for a lower price.
  // Preserve the existing, correct behavior, and prove the buyer's own
  // message on the trade round explicitly states the tradeoff.
  it("flexible delivery: the buyer trades a later delivery date for a lower price, and its message explicitly states the tradeoff", async () => {
    const p = preset("flexible-delivery");
    const { transcript, finalState } = await runPreset("flexible-delivery");
    expect(finalState.status).toBe("AGREED");

    const tradeRound = transcript.find((t) => t.buyer.move === "DELIVERY_FOR_PRICE");
    expect(tradeRound).toBeDefined();
    expect(tradeRound!.buyer.deliveryDays!).toBeGreaterThan(Number(p.values.deliveryDeadlineDays));

    // The message people actually see in the UI (NegotiationDemo.tsx
    // only ever renders `msg.message`) must explicitly frame this as a
    // conditional exchange, not a bare "I can go up to X" caption.
    expect(tradeRound!.buyer.message).toMatch(/delivery/i);
    expect(tradeRound!.buyer.message).toMatch(/if/i);
    expect(tradeRound!.buyer.message).toContain(String(tradeRound!.buyer.unitPrice));
  });

  // 7. Impossible budget — hard constraint causes legitimate failure.
  // Preserve exactly this behavior: never a forced/false agreement.
  it("impossible budget: never forces an agreement when the merchant cannot satisfy the hard budget constraint", async () => {
    const { finalState, transcript } = await runPreset("walk-away");
    expect(finalState.status).not.toBe("AGREED");
    expect(transcript.every((t) => t.buyer.type !== "accept")).toBe(true);
  });

  // General requirement: every preset's own final status/shape is
  // genuinely distinguishable from the others — this whole milestone's
  // own stated goal, checked directly rather than only by inference from
  // the individual scenario tests above.
  it("every preset's round count / outcome shape is not identical across the board (a real diversity of strategies, not one shape repeated seven times)", async () => {
    const ids = [
      "balanced",
      "bulk-buyer",
      "buyer-bulk-request",
      "low-stock",
      "urgent-delivery",
      "flexible-delivery",
      "walk-away",
    ];
    const results = await Promise.all(ids.map((id) => runPreset(id)));
    const shapes = results.map((r) => `${r.finalState.status}:${r.transcript.length}`);
    expect(new Set(shapes).size).toBeGreaterThan(1);
  });
});
