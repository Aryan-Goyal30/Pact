// Exercises the REAL Prisma/SQLite dev database, same deliberate,
// scoped exception to the "don't test thin DB wrappers" convention that
// agreementRepository.test.ts documents — this milestone specifically
// asked to prove the read path returns genuinely persisted rows, in
// order, joined correctly across the sessionId/agreementId split. Every
// row this file creates is deleted again in afterEach.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { listAuditTrail } from "./auditTrailRepository";
import { AUDIT_EVENT_AGREEMENT_CREATED } from "./agreementRepository";
import { AUDIT_EVENT_NEGOTIATION_DECISION, createNegotiationSession } from "./negotiationSessionRepository";
import { POST as postTurn } from "@/app/api/negotiations/[id]/turn/route";
import { createPaymentAttempt, AUDIT_EVENT_PAYMENT_ORDER_CREATED } from "@/lib/payment/paymentRepository";
import { getLlmProvider } from "@/lib/llm/provider";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import type { NegotiationTurnResponse } from "@/types/negotiation";

vi.mock("@/lib/llm/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/provider")>();
  return { ...actual, getLlmProvider: vi.fn() };
});

const mockedGetLlmProvider = vi.mocked(getLlmProvider);
const generateAgentMessage = vi.fn().mockResolvedValue("mocked agent message");

const LAPTOP_SKU = "LAPTOP-14-I5";
let sessionIdsToClean: string[] = [];
let agreementIdsToClean: string[] = [];

beforeEach(() => {
  sessionIdsToClean = [];
  agreementIdsToClean = [];
  generateAgentMessage.mockClear();
  mockedGetLlmProvider.mockReturnValue({ generateAgentMessage });
});

afterEach(async () => {
  for (const agreementId of agreementIdsToClean) {
    await prisma.auditLog.deleteMany({ where: { agreementId } });
    await prisma.paymentAttempt.deleteMany({ where: { agreementId } });
  }
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

async function callTurn(id: string): Promise<NegotiationTurnResponse> {
  const response = await postTurn(new Request("http://localhost/api/negotiations/x/turn", { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
  return (await response.json()) as NegotiationTurnResponse;
}

// Reaches AGREED in exactly two real, persisted turns — the same
// deterministic fixture turn/route.test.ts's own AGREEING_CONSTRAINTS uses.
const AGREEING_CONSTRAINTS: BuyerConstraints = {
  sku: LAPTOP_SKU,
  quantity: 10,
  maxUnitPrice: 48000,
  deliveryDeadlineDays: 5,
};

describe("listAuditTrail", () => {
  it("returns one NEGOTIATION_DECISION entry per persisted decided turn, in chronological order, carrying the real TurnDecisionAudit", async () => {
    const sessionId = await createTestSession(AGREEING_CONSTRAINTS);
    const first = await callTurn(sessionId);
    const second = await callTurn(sessionId);
    expect(second.status).toBe("AGREED");

    const entries = await listAuditTrail(sessionId);
    const decisionEntries = entries.filter((e) => e.eventType === AUDIT_EVENT_NEGOTIATION_DECISION);

    expect(decisionEntries).toHaveLength(2);
    expect(decisionEntries[0].turn).toBe(1);
    expect(decisionEntries[1].turn).toBe(2);
    // Chronological: row 1 was persisted strictly before row 2.
    expect(decisionEntries[0].createdAt.getTime()).toBeLessThanOrEqual(decisionEntries[1].createdAt.getTime());

    // The exact TurnDecisionAudit already persisted — reused verbatim,
    // not re-derived or reshaped.
    expect(decisionEntries[0].decision).toEqual(first.decisionAudit);
    expect(decisionEntries[0].decision!.buyer.side).toBe("buyer");
    expect(decisionEntries[0].decision!.buyer.observation).toBeDefined();
    expect(decisionEntries[0].payload).toBeUndefined();
  });

  it("returns AGREEMENT_CREATED once the negotiation closes, with the agreed terms as its payload", async () => {
    const sessionId = await createTestSession(AGREEING_CONSTRAINTS);
    await callTurn(sessionId);
    const closing = await callTurn(sessionId);
    expect(closing.status).toBe("AGREED");
    if (closing.agreement) agreementIdsToClean.push(closing.agreement.id);

    const entries = await listAuditTrail(sessionId);
    const agreementEntry = entries.find((e) => e.eventType === AUDIT_EVENT_AGREEMENT_CREATED);

    expect(agreementEntry).toBeDefined();
    expect(agreementEntry!.turn).toBeUndefined();
    expect(agreementEntry!.decision).toBeUndefined();
    expect(agreementEntry!.payload).toMatchObject({
      sku: LAPTOP_SKU,
      quantity: closing.agreement!.quantity,
      unitPrice: closing.agreement!.unitPrice,
      deliveryDays: closing.agreement!.deliveryDays,
    });
  });

  it("returns payment-family events associated only through agreementId, not sessionId", async () => {
    const sessionId = await createTestSession(AGREEING_CONSTRAINTS);
    await callTurn(sessionId);
    const closing = await callTurn(sessionId);
    const agreementId = closing.agreement!.id;
    agreementIdsToClean.push(agreementId);

    // Sanity check the premise this test proves: the row this creates
    // carries agreementId but genuinely no sessionId at all.
    const { attempt } = await createPaymentAttempt({
      agreementId,
      attemptNumber: 1,
      isRecovery: false,
      razorpayOrderId: "order_test_123",
    });
    const rawRow = await prisma.auditLog.findFirst({
      where: { paymentAttemptId: attempt.id, eventType: AUDIT_EVENT_PAYMENT_ORDER_CREATED },
    });
    expect(rawRow?.sessionId).toBeNull();
    expect(rawRow?.agreementId).toBe(agreementId);

    const entries = await listAuditTrail(sessionId);
    const paymentEntry = entries.find((e) => e.eventType === AUDIT_EVENT_PAYMENT_ORDER_CREATED);

    expect(paymentEntry).toBeDefined();
    expect(paymentEntry!.payload).toMatchObject({ razorpayOrderId: "order_test_123", attemptNumber: 1 });
    // Still ordered chronologically alongside the negotiation/agreement rows.
    const lastIndex = entries.length - 1;
    expect(entries[lastIndex].eventType).toBe(AUDIT_EVENT_PAYMENT_ORDER_CREATED);
  });

  it("never fabricates events that don't exist — a negotiation with no agreement yet has no AGREEMENT_CREATED or payment rows", async () => {
    const sessionId = await createTestSession(AGREEING_CONSTRAINTS);
    await callTurn(sessionId); // round 1 only — not yet AGREED

    const entries = await listAuditTrail(sessionId);

    expect(entries.some((e) => e.eventType === AUDIT_EVENT_AGREEMENT_CREATED)).toBe(false);
    expect(entries.filter((e) => e.eventType === AUDIT_EVENT_NEGOTIATION_DECISION)).toHaveLength(1);
  });

  it("returns an empty array for an unknown session id, rather than throwing", async () => {
    expect(await listAuditTrail("does-not-exist")).toEqual([]);
  });

  it("does not crash on a malformed payload — the row still appears, with a safe error marker instead of parsed facts", async () => {
    const sessionId = await createTestSession(AGREEING_CONSTRAINTS);
    await callTurn(sessionId);

    await prisma.auditLog.create({
      data: { eventType: "SOME_FUTURE_EVENT", sessionId, payload: "{not valid json" },
    });

    const entries = await listAuditTrail(sessionId);
    const malformed = entries.find((e) => e.eventType === "SOME_FUTURE_EVENT");

    expect(malformed).toBeDefined();
    expect(malformed!.payload).toEqual({ error: expect.any(String) });
    // The genuinely well-formed row alongside it is completely unaffected.
    expect(entries.filter((e) => e.eventType === AUDIT_EVENT_NEGOTIATION_DECISION)).toHaveLength(1);
  });
});
