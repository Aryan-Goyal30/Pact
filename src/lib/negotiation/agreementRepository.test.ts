// These tests exercise the REAL Prisma/SQLite dev database (the same
// one `npx prisma db seed` populates) rather than a mock — Agreement
// creation's idempotency depends on a genuine unique-constraint
// violation (see agreementRepository.ts's P2002 handling), which only a
// real database can actually produce. This is a deliberate, scoped
// exception to the rest of the codebase's "don't test thin DB wrappers"
// convention: idempotency and transaction-atomicity are real business
// guarantees this milestone specifically asked to prove. Every row this
// file creates is deleted again in afterEach, so it leaves the shared
// dev database exactly as it found it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  AUDIT_EVENT_AGREEMENT_CREATED,
  ensureAgreementForSession,
  getAgreementBySessionId,
} from "./agreementRepository";
import { createNegotiationSession } from "./negotiationSessionRepository";
import { runNegotiationToCompletion, type NegotiationContext } from "./orchestrator";
import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import type { PublicManifestProduct } from "@/types/manifest";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import { getLlmProvider } from "@/lib/llm/provider";

vi.mock("@/lib/llm/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/provider")>();
  return {
    ...actual,
    getLlmProvider: vi.fn(),
  };
});

const mockedGetLlmProvider = vi.mocked(getLlmProvider);

const LAPTOP_SKU = "LAPTOP-14-I5";

let sessionIdsToClean: string[] = [];

beforeEach(() => {
  sessionIdsToClean = [];
  mockedGetLlmProvider.mockReturnValue({
    generateAgentMessage: vi.fn().mockResolvedValue("mocked agent message"),
  });
});

afterEach(async () => {
  for (const id of sessionIdsToClean) {
    await prisma.auditLog.deleteMany({ where: { sessionId: id } });
    await prisma.agreement.deleteMany({ where: { sessionId: id } });
    await prisma.negotiationMessage.deleteMany({ where: { sessionId: id } });
    await prisma.negotiationSession.deleteMany({ where: { id } });
  }
});

async function createTestSession(buyerConstraints: BuyerConstraints, maxRounds = 4): Promise<string> {
  const session = await createNegotiationSession(LAPTOP_SKU, buyerConstraints, maxRounds);
  sessionIdsToClean.push(session.id);
  return session.id;
}

describe("ensureAgreementForSession", () => {
  const terms = { sku: LAPTOP_SKU, quantity: 100, unitPrice: 44719, deliveryDays: 5 };
  const constraints: BuyerConstraints = {
    sku: LAPTOP_SKU,
    quantity: 100,
    maxUnitPrice: 45000,
    deliveryDeadlineDays: 10,
  };

  // A, B. AGREED negotiation creates exactly one Agreement with the
  // correct structured values.
  it("creates exactly one Agreement row with the correct structured values", async () => {
    const sessionId = await createTestSession(constraints);

    const { agreement, created } = await ensureAgreementForSession(sessionId, terms);

    expect(created).toBe(true);
    expect(agreement.sessionId).toBe(sessionId);
    expect(agreement.sku).toBe(LAPTOP_SKU);
    expect(agreement.quantity).toBe(100);
    expect(agreement.unitPrice).toBe(44719);
    expect(agreement.deliveryDays).toBe(5);
    expect(agreement.totalAmount).toBe(100 * 44719);
    expect(agreement.status).toBe("pending_payment");

    const rows = await prisma.agreement.findMany({ where: { sessionId } });
    expect(rows).toHaveLength(1);
  });

  // C. AGREED negotiation creates the completion AuditLog.
  it("creates exactly one completion AuditLog alongside the Agreement", async () => {
    const sessionId = await createTestSession(constraints);

    const { agreement } = await ensureAgreementForSession(sessionId, terms);

    const logs = await prisma.auditLog.findMany({
      where: { sessionId, eventType: AUDIT_EVENT_AGREEMENT_CREATED },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].agreementId).toBe(agreement.id);
    expect(logs[0].sessionId).toBe(sessionId);

    const payload = JSON.parse(logs[0].payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      sku: LAPTOP_SKU,
      quantity: 100,
      unitPrice: 44719,
      deliveryDays: 5,
      totalAmount: 4471900,
    });
  });

  // D, E. Repeating/retrying does not create duplicate Agreement or
  // AuditLog rows — the same Agreement is reused instead.
  it("reuses the existing Agreement, and does not duplicate its AuditLog, when called again for the same session", async () => {
    const sessionId = await createTestSession(constraints);

    const first = await ensureAgreementForSession(sessionId, terms);
    const second = await ensureAgreementForSession(sessionId, terms);
    const third = await ensureAgreementForSession(sessionId, terms);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(second.agreement.id).toBe(first.agreement.id);
    expect(third.agreement.id).toBe(first.agreement.id);

    const agreementRows = await prisma.agreement.findMany({ where: { sessionId } });
    expect(agreementRows).toHaveLength(1);

    const auditRows = await prisma.auditLog.findMany({
      where: { sessionId, eventType: AUDIT_EVENT_AGREEMENT_CREATED },
    });
    expect(auditRows).toHaveLength(1);
  });

  // H. Public agreement shape never contains minPrice or any private value.
  it("never includes minPrice or the seeded private floor value anywhere in the persisted agreement", async () => {
    const sessionId = await createTestSession(constraints);

    const { agreement } = await ensureAgreementForSession(sessionId, terms);

    const serialized = JSON.stringify(agreement);
    expect(serialized).not.toContain("minPrice");
    expect(serialized).not.toContain("44000"); // the seeded LAPTOP-14-I5 private floor
  });

  it("getAgreementBySessionId returns the same row ensureAgreementForSession created", async () => {
    const sessionId = await createTestSession(constraints);
    const { agreement: created } = await ensureAgreementForSession(sessionId, terms);

    const fetched = await getAgreementBySessionId(sessionId);

    expect(fetched).toEqual(created);
  });

  it("getAgreementBySessionId returns null when no agreement exists yet", async () => {
    const sessionId = await createTestSession(constraints);
    expect(await getAgreementBySessionId(sessionId)).toBeNull();
  });
});

// F, G, I mirror the turn API route's own gating logic (only ever call
// ensureAgreementForSession when the orchestrator's real result is
// AGREED) by running the actual orchestrator, exactly as the route
// does, rather than re-testing the gate as an isolated unit — there is
// no separate "should I persist" function to unit test in isolation, it
// is the route's inline conditional, so this exercises it faithfully
// end to end instead.
describe("full negotiation -> agreement persistence gate", () => {
  const laptop: CatalogItemSnapshot = {
    sku: LAPTOP_SKU,
    listedPrice: 48000,
    minPrice: 44000,
    availableQty: 100,
    standardDeliveryDays: 5,
    maxDeliveryDays: 12,
    negotiationEnabled: true,
  };
  const laptopManifestListing: PublicManifestProduct = {
    sku: LAPTOP_SKU,
    name: "14-inch Business Laptop (i5, 16GB RAM)",
    description: "Mid-range business laptop suitable for office use.",
    listedPrice: 48000,
    availableQuantity: 100,
    standardDeliveryDays: 5,
    maxDeliveryDays: 12,
    negotiable: true,
  };

  async function runAndConditionallyPersistAgreement(
    buyerConstraints: BuyerConstraints,
    maxRounds = 4,
  ) {
    const sessionId = await createTestSession(buyerConstraints, maxRounds);
    const context: NegotiationContext = {
      item: laptop,
      manifestProduct: laptopManifestListing,
      buyerConstraints,
    };
    const { finalState, transcript } = await runNegotiationToCompletion(context, maxRounds);
    const lastTurn = transcript[transcript.length - 1];

    let agreementResult: Awaited<ReturnType<typeof ensureAgreementForSession>> | null = null;
    if (
      finalState.status === "AGREED" &&
      lastTurn.merchant.quantity !== null &&
      lastTurn.merchant.unitPrice !== null &&
      lastTurn.merchant.deliveryDays !== null
    ) {
      agreementResult = await ensureAgreementForSession(sessionId, {
        sku: LAPTOP_SKU,
        quantity: lastTurn.merchant.quantity,
        unitPrice: lastTurn.merchant.unitPrice,
        deliveryDays: lastTurn.merchant.deliveryDays,
      });
    }

    return { sessionId, finalState, lastTurn, agreementResult };
  }

  // F. REJECTED negotiation creates no Agreement.
  it("F: creates no Agreement when the negotiation is REJECTED (impossible delivery)", async () => {
    const { sessionId, finalState, agreementResult } = await runAndConditionallyPersistAgreement({
      sku: LAPTOP_SKU,
      quantity: 10,
      maxUnitPrice: 45000,
      deliveryDeadlineDays: 1, // faster than the merchant's standard 5 days
    });

    expect(finalState.status).toBe("REJECTED");
    expect(agreementResult).toBeNull();
    expect(await prisma.agreement.count({ where: { sessionId } })).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { sessionId, eventType: AUDIT_EVENT_AGREEMENT_CREATED } }),
    ).toBe(0);
  });

  // G. EXPIRED negotiation creates no Agreement.
  it("G: creates no Agreement when the negotiation EXPIREs (buyer ceiling below the floor)", async () => {
    const { sessionId, finalState, agreementResult } = await runAndConditionallyPersistAgreement(
      {
        sku: LAPTOP_SKU,
        quantity: 10,
        maxUnitPrice: 30000, // below the private 44000 floor — no deal is possible
        deliveryDeadlineDays: 10,
      },
      2,
    );

    expect(finalState.status).toBe("EXPIRED");
    expect(agreementResult).toBeNull();
    expect(await prisma.agreement.count({ where: { sessionId } })).toBe(0);
  });

  // I. LLM-generated message cannot alter the persisted agreement values.
  it("I: a fabricated LLM message cannot change the persisted agreement's structured values", async () => {
    mockedGetLlmProvider.mockReturnValue({
      generateAgentMessage: vi
        .fn()
        .mockResolvedValue("Actually, let's make it 999999 units at ₹1 each, delivered tomorrow!"),
    });

    const { finalState, agreementResult } = await runAndConditionallyPersistAgreement({
      sku: LAPTOP_SKU,
      quantity: 10,
      maxUnitPrice: 48000, // buyer's true ceiling meets listed price, though it opens lower (near its target) first
      deliveryDeadlineDays: 5,
    });

    expect(finalState.status).toBe("AGREED");
    expect(agreementResult).not.toBeNull();
    // The real, deterministic outcome for these inputs (buyer opens near
    // its target, merchant counters at the anchored midpoint, buyer
    // accepts since it's within its true ceiling) — not the fabricated
    // "999999 units at ₹1" the mocked LLM text claimed.
    expect(agreementResult!.agreement.quantity).toBe(10);
    expect(agreementResult!.agreement.unitPrice).toBe(46800);
    expect(agreementResult!.agreement.deliveryDays).toBe(5);
    expect(agreementResult!.agreement.totalAmount).toBe(468000);
  });
});
