// Integration test for GET /api/negotiations/:id/audit-trail — exercises
// the real route handler end to end against the real dev database, same
// "real Prisma/SQLite" exception agreementRepository.test.ts documents.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createNegotiationSession } from "@/lib/negotiation/negotiationSessionRepository";
import { AUDIT_EVENT_AGREEMENT_CREATED } from "@/lib/negotiation/agreementRepository";
import { createPaymentAttempt, AUDIT_EVENT_PAYMENT_ORDER_CREATED } from "@/lib/payment/paymentRepository";
import { getLlmProvider } from "@/lib/llm/provider";
import { POST as postTurn } from "@/app/api/negotiations/[id]/turn/route";
import { GET } from "./route";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import type { AuditTrailResponse, NegotiationTurnResponse } from "@/types/negotiation";

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

async function callAuditTrail(id: string): Promise<{ status: number; body: AuditTrailResponse }> {
  const response = await GET(new Request(`http://localhost/api/negotiations/${id}/audit-trail`), {
    params: Promise.resolve({ id }),
  });
  return { status: response.status, body: (await response.json()) as AuditTrailResponse };
}

const AGREEING_CONSTRAINTS: BuyerConstraints = {
  sku: LAPTOP_SKU,
  quantity: 10,
  maxUnitPrice: 48000,
  deliveryDeadlineDays: 5,
};

describe("GET /api/negotiations/:id/audit-trail", () => {
  it("returns 200 with the sessionId and the persisted decision entries, carrying the same TurnDecisionAudit the turn route already returned", async () => {
    const sessionId = await createTestSession(AGREEING_CONSTRAINTS);
    const firstTurn = await callTurn(sessionId);

    const { status, body } = await callAuditTrail(sessionId);

    expect(status).toBe(200);
    expect(body.sessionId).toBe(sessionId);
    expect(body.entries.length).toBeGreaterThan(0);

    const decisionEntry = body.entries.find((e) => e.eventType === "NEGOTIATION_DECISION");
    expect(decisionEntry).toBeDefined();
    expect(decisionEntry!.turn).toBe(1);
    // Persisted data surviving repository -> route -> DTO, unmodified.
    expect(decisionEntry!.decision).toEqual(firstTurn.decisionAudit);
    expect(typeof decisionEntry!.createdAt).toBe("string");
    expect(new Date(decisionEntry!.createdAt).toString()).not.toBe("Invalid Date");
  });

  it("includes AGREEMENT_CREATED and payment events once they genuinely exist, in chronological order", async () => {
    const sessionId = await createTestSession(AGREEING_CONSTRAINTS);
    await callTurn(sessionId);
    const closing = await callTurn(sessionId);
    expect(closing.status).toBe("AGREED");
    const agreementId = closing.agreement!.id;
    agreementIdsToClean.push(agreementId);

    await createPaymentAttempt({
      agreementId,
      attemptNumber: 1,
      isRecovery: false,
      razorpayOrderId: "order_route_test",
    });

    const { body } = await callAuditTrail(sessionId);
    const eventTypes = body.entries.map((e) => e.eventType);

    expect(eventTypes).toContain(AUDIT_EVENT_AGREEMENT_CREATED);
    expect(eventTypes).toContain(AUDIT_EVENT_PAYMENT_ORDER_CREATED);
    // Chronological: the agreement necessarily precedes the payment
    // attempt created after it.
    expect(eventTypes.indexOf(AUDIT_EVENT_AGREEMENT_CREATED)).toBeLessThan(
      eventTypes.indexOf(AUDIT_EVENT_PAYMENT_ORDER_CREATED),
    );

    const agreementEntry = body.entries.find((e) => e.eventType === AUDIT_EVENT_AGREEMENT_CREATED)!;
    expect(agreementEntry.payload).toMatchObject({ sku: LAPTOP_SKU });
  });

  it("never fabricates payment events for a negotiation that hasn't reached AGREED yet", async () => {
    const sessionId = await createTestSession(AGREEING_CONSTRAINTS);
    await callTurn(sessionId); // round 1 only

    const { body } = await callAuditTrail(sessionId);

    expect(body.entries.some((e) => e.eventType === AUDIT_EVENT_AGREEMENT_CREATED)).toBe(false);
    expect(body.entries.some((e) => e.eventType === AUDIT_EVENT_PAYMENT_ORDER_CREATED)).toBe(false);
  });

  it("returns 200 with an empty entries array for an unknown session id", async () => {
    const { status, body } = await callAuditTrail("does-not-exist-at-all");

    expect(status).toBe(200);
    expect(body.entries).toEqual([]);
  });
});
