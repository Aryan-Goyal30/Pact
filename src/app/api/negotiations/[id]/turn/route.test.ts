// Integration tests for POST /api/negotiations/:id/turn, focused on the
// hardening added after the Agreement + AuditLog milestone: a repeated
// POST against an already-AGREED session must be a safe, idempotent
// replay (no new orchestrator turn, no LLM call, no duplicate Agreement
// or AuditLog row) rather than the plain 409 it used to return. Exercises
// the real route handler end to end against the real dev database, the
// same "real Prisma/SQLite" exception to the no-DB-tests convention that
// agreementRepository.test.ts documents.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { AUDIT_EVENT_AGREEMENT_CREATED } from "@/lib/negotiation/agreementRepository";
import { createNegotiationSession } from "@/lib/negotiation/negotiationSessionRepository";
import { getLlmProvider } from "@/lib/llm/provider";
import { POST } from "./route";
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

beforeEach(() => {
  sessionIdsToClean = [];
  generateAgentMessage.mockClear();
  mockedGetLlmProvider.mockReturnValue({ generateAgentMessage });
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

async function callTurn(id: string): Promise<{ status: number; body: NegotiationTurnResponse }> {
  const response = await POST(new Request("http://localhost/api/negotiations/x/turn", { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
  return { status: response.status, body: (await response.json()) as NegotiationTurnResponse };
}

// Buyer ceiling of 48000 meets the merchant's listed price, so this
// reaches AGREED in exactly two turns: turn 1 the buyer opens near its
// target and the merchant counters at the anchored midpoint (46800);
// turn 2 the buyer accepts since 46800 is within its 48000 ceiling. This
// is the same deterministic sequence agreementRepository.test.ts's "I"
// test relies on.
const AGREEING_CONSTRAINTS: BuyerConstraints = {
  sku: LAPTOP_SKU,
  quantity: 10,
  maxUnitPrice: 48000,
  deliveryDeadlineDays: 5,
};

describe("POST /api/negotiations/:id/turn — replay after AGREED", () => {
  it("A: the first turn that reaches AGREED creates exactly one Agreement and one AuditLog", async () => {
    const sessionId = await createTestSession(AGREEING_CONSTRAINTS);

    await callTurn(sessionId); // turn 1: counter_offer
    const closing = await callTurn(sessionId); // turn 2: AGREED

    expect(closing.status).toBe(200);
    expect(closing.body.status).toBe("AGREED");
    expect(closing.body.agreement).not.toBeNull();
    expect(closing.body.agreement).toMatchObject({
      sku: LAPTOP_SKU,
      quantity: 10,
      unitPrice: 46800,
      deliveryDays: 5,
      totalAmount: 468000,
      status: "pending_payment",
    });

    expect(await prisma.agreement.count({ where: { sessionId } })).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { sessionId, eventType: AUDIT_EVENT_AGREEMENT_CREATED } }),
    ).toBe(1);
  });

  // Leverage-visualization milestone: every turn response carries a live,
  // server-computed leverage score (never from the LLM) — this proves the
  // real API data path, not just the pure computeLeverage() unit tests.
  it("every turn response includes a valid 0-100 leverage score, and the AGREED replay recomputes it consistently", async () => {
    const sessionId = await createTestSession(AGREEING_CONSTRAINTS);

    const first = await callTurn(sessionId);
    expect(first.body.leverage.buyer + first.body.leverage.merchant).toBe(100);
    expect(first.body.leverage.buyer).toBeGreaterThanOrEqual(0);
    expect(first.body.leverage.buyer).toBeLessThanOrEqual(100);

    const closing = await callTurn(sessionId); // AGREED
    expect(closing.body.leverage.buyer + closing.body.leverage.merchant).toBe(100);

    const replay = await callTurn(sessionId);
    expect(replay.body.leverage).toEqual(closing.body.leverage);
  });

  it("B, C, D, E: repeating the POST after AGREED replays the same Agreement without a new turn, LLM call, Agreement, or AuditLog", async () => {
    const sessionId = await createTestSession(AGREEING_CONSTRAINTS);

    await callTurn(sessionId); // turn 1
    const closing = await callTurn(sessionId); // turn 2: AGREED
    const callsAfterClosing = generateAgentMessage.mock.calls.length;

    const replay = await callTurn(sessionId);

    // B: same Agreement.
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe("AGREED");
    expect(replay.body.agreement).toEqual(closing.body.agreement);

    // C, D: no duplicate rows.
    expect(await prisma.agreement.count({ where: { sessionId } })).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { sessionId, eventType: AUDIT_EVENT_AGREEMENT_CREATED } }),
    ).toBe(1);

    // E: the LLM was not invoked again for the replay.
    expect(generateAgentMessage.mock.calls.length).toBe(callsAfterClosing);

    // Replaying again (a third time) is equally safe.
    const secondReplay = await callTurn(sessionId);
    expect(secondReplay.status).toBe(200);
    expect(secondReplay.body.agreement).toEqual(closing.body.agreement);
    expect(await prisma.agreement.count({ where: { sessionId } })).toBe(1);
    expect(generateAgentMessage.mock.calls.length).toBe(callsAfterClosing);
  });

  it("F: the replay response contains no minPrice or private reservation value", async () => {
    const sessionId = await createTestSession(AGREEING_CONSTRAINTS);

    await callTurn(sessionId);
    await callTurn(sessionId); // AGREED
    const replay = await callTurn(sessionId);

    const serialized = JSON.stringify(replay.body);
    expect(serialized).not.toContain("minPrice");
    expect(serialized).not.toContain("44000"); // the seeded LAPTOP-14-I5 private floor
  });

  // PACT V2 Milestone 4 regression: the DB-backed path (loadLatestTurn ->
  // previousBuyerUnitPrice) must apply the exact same reciprocity as the
  // in-memory orchestrator path — these are the same pinned values
  // verified in orchestrator.test.ts's flagship trace (200 laptops
  // requested, 100 available), reproduced here through the real route
  // handler and real SQLite session/message persistence.
  it("Milestone 4: the merchant's second-round counter reflects buyer reciprocity through the persisted DB-backed history path", async () => {
    const sessionId = await createTestSession(
      { sku: LAPTOP_SKU, quantity: 200, maxUnitPrice: 45000, deliveryDeadlineDays: 10 },
      4,
    );

    const first = await callTurn(sessionId); // round 1: no prior buyer price -> UNKNOWN, neutral
    expect(first.body.buyer.unitPrice).toBe(42750);
    expect(first.body.merchant.unitPrice).toBe(45375);

    const second = await callTurn(sessionId); // round 2: buyer's ask rose (42750 -> 44063) -> CONCEDED
    expect(second.body.buyer.unitPrice).toBe(44063);
    expect(second.body.merchant.unitPrice).toBe(44621); // reciprocity-adjusted, not the pre-Milestone-4 44719
  });

  it("a REJECTED session still returns 409 on a repeated POST (unchanged behavior)", async () => {
    const sessionId = await createTestSession(
      { sku: LAPTOP_SKU, quantity: 10, maxUnitPrice: 45000, deliveryDeadlineDays: 1 },
      4,
    );

    const first = await callTurn(sessionId);
    expect(first.body.status).toBe("REJECTED");

    const second = await callTurn(sessionId);
    expect(second.status).toBe(409);
  });
});
