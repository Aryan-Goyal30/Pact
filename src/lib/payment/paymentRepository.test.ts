// Real Prisma/SQLite dev database tests — same deliberate, scoped
// exception agreementRepository.test.ts already documents: idempotency
// and conditional-update correctness depend on genuine database
// behavior (a real P2002 unique-constraint violation, a real
// `updateMany` affected-row count) that a mock could not honestly prove.
// Every row created here is deleted in afterEach.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createNegotiationSession } from "@/lib/negotiation/negotiationSessionRepository";
import { ensureAgreementForSession } from "@/lib/negotiation/agreementRepository";
import { getLlmProvider } from "@/lib/llm/provider";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import {
  AUDIT_EVENT_PAYMENT_FAILED,
  AUDIT_EVENT_PAYMENT_ORDER_CREATED,
  AUDIT_EVENT_PAYMENT_SUCCEEDED,
  AUDIT_EVENT_RECOVERY_FAILED,
  AUDIT_EVENT_RECOVERY_STARTED,
  AUDIT_EVENT_RECOVERY_SUCCEEDED,
  AUDIT_EVENT_WEBHOOK_RECEIVED,
  createPaymentAttempt,
  findUnresolvedAttempt,
  findUnresolvedAttemptByOrderId,
  hasWebhookEventBeenProcessed,
  listPaymentAttempts,
  recordWebhookReceived,
  resolvePaymentAttempt,
} from "./paymentRepository";

vi.mock("@/lib/llm/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/provider")>();
  return { ...actual, getLlmProvider: vi.fn() };
});
const mockedGetLlmProvider = vi.mocked(getLlmProvider);

const LAPTOP_SKU = "LAPTOP-14-I5";
let sessionIdsToClean: string[] = [];

beforeEach(() => {
  sessionIdsToClean = [];
  mockedGetLlmProvider.mockReturnValue({ generateAgentMessage: vi.fn().mockResolvedValue("mocked") });
});

afterEach(async () => {
  for (const id of sessionIdsToClean) {
    const agreement = await prisma.agreement.findUnique({ where: { sessionId: id } });
    if (agreement) {
      await prisma.auditLog.deleteMany({ where: { agreementId: agreement.id } });
      await prisma.paymentAttempt.deleteMany({ where: { agreementId: agreement.id } });
    }
    await prisma.auditLog.deleteMany({ where: { sessionId: id } });
    await prisma.agreement.deleteMany({ where: { sessionId: id } });
    await prisma.negotiationMessage.deleteMany({ where: { sessionId: id } });
    await prisma.negotiationSession.deleteMany({ where: { id } });
  }
});

/** A real, valid Agreement row (pending_payment) — the fixture every test in this file builds on. */
async function createTestAgreement(): Promise<{ agreementId: string; sessionId: string }> {
  const constraints: BuyerConstraints = {
    sku: LAPTOP_SKU,
    quantity: 100,
    maxUnitPrice: 45000,
    deliveryDeadlineDays: 10,
  };
  const session = await createNegotiationSession(LAPTOP_SKU, constraints, 4);
  sessionIdsToClean.push(session.id);
  const { agreement } = await ensureAgreementForSession(session.id, {
    sku: LAPTOP_SKU,
    quantity: 100,
    unitPrice: 44719,
    deliveryDays: 5,
  });
  return { agreementId: agreement.id, sessionId: session.id };
}

describe("createPaymentAttempt — deterministic-id idempotency", () => {
  it("creates a PaymentAttempt with status='created' and its own AuditLog row, in one write", async () => {
    const { agreementId } = await createTestAgreement();

    const { attempt, created } = await createPaymentAttempt({
      agreementId,
      attemptNumber: 1,
      isRecovery: false,
      razorpayOrderId: "order_abc",
    });

    expect(created).toBe(true);
    expect(attempt.status).toBe("created");
    expect(attempt.razorpayOrderId).toBe("order_abc");
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.isRecovery).toBe(false);

    const logs = await prisma.auditLog.findMany({ where: { paymentAttemptId: attempt.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].eventType).toBe(AUDIT_EVENT_PAYMENT_ORDER_CREATED);
  });

  it("a repeated call for the SAME (agreementId, attemptNumber) returns the existing row instead of creating a duplicate — the deterministic-id + P2002 mechanism", async () => {
    const { agreementId } = await createTestAgreement();

    const first = await createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_abc" });
    const second = await createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_abc" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.attempt.id).toBe(first.attempt.id);

    const rows = await prisma.paymentAttempt.findMany({ where: { agreementId } });
    expect(rows).toHaveLength(1); // never a duplicate row
  });

  it("concurrent duplicate requests for the same attempt never both succeed — at most one row is ever created", async () => {
    const { agreementId } = await createTestAgreement();

    // Two genuinely concurrent calls — the realistic "double-click"
    // shape (see Milestone 13's own test D) — rather than an artificially
    // wide fan-out, which under this project's real SQLite/better-sqlite3
    // write-serialization can legitimately time out once combined with
    // the rest of the full test suite's own concurrent DB load. The
    // property under test (the database, not timing, is the real
    // guarantee) is fully proven at 2 concurrent writers; it does not
    // need a wider race to demonstrate.
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_concurrent" }),
      ),
    );

    expect(results.filter((r) => r.created).length).toBe(1); // exactly one genuine creation
    const rows = await prisma.paymentAttempt.findMany({ where: { agreementId } });
    expect(rows).toHaveLength(1);
  });

  it("a recovery attempt (isRecovery=true) writes RECOVERY_STARTED, not PAYMENT_ORDER_CREATED", async () => {
    const { agreementId } = await createTestAgreement();

    const { attempt } = await createPaymentAttempt({ agreementId, attemptNumber: 2, isRecovery: true, razorpayOrderId: "order_abc" });

    const logs = await prisma.auditLog.findMany({ where: { paymentAttemptId: attempt.id } });
    expect(logs[0].eventType).toBe(AUDIT_EVENT_RECOVERY_STARTED);
  });

  it("different attemptNumbers for the same Agreement produce genuinely distinct rows", async () => {
    const { agreementId } = await createTestAgreement();
    const a1 = await createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_1" });
    const a2 = await createPaymentAttempt({ agreementId, attemptNumber: 2, isRecovery: true, razorpayOrderId: "order_1" });
    expect(a1.attempt.id).not.toBe(a2.attempt.id);
  });
});

describe("findUnresolvedAttempt / findUnresolvedAttemptByOrderId", () => {
  it("returns null when no PaymentAttempt exists yet", async () => {
    const { agreementId } = await createTestAgreement();
    expect(await findUnresolvedAttempt(agreementId)).toBeNull();
  });

  it("finds the single 'created' attempt", async () => {
    const { agreementId } = await createTestAgreement();
    const { attempt } = await createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_x" });

    const found = await findUnresolvedAttempt(agreementId);
    expect(found?.id).toBe(attempt.id);
  });

  it("returns null once the attempt has settled (no longer 'created')", async () => {
    const { agreementId } = await createTestAgreement();
    const { attempt } = await createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_x" });
    await resolvePaymentAttempt({ attempt, outcome: "success", source: "verify" });

    expect(await findUnresolvedAttempt(agreementId)).toBeNull();
  });

  it("findUnresolvedAttemptByOrderId locates the unresolved attempt across Agreements, by order id alone (the webhook's own lookup)", async () => {
    const { agreementId } = await createTestAgreement();
    const { attempt } = await createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_shared" });

    const found = await findUnresolvedAttemptByOrderId("order_shared");
    expect(found?.id).toBe(attempt.id);
  });

  it("disambiguates correctly when a recovery attempt reuses the SAME razorpayOrderId as the (already-failed) original attempt", async () => {
    const { agreementId } = await createTestAgreement();
    const { attempt: first } = await createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_reused" });
    await resolvePaymentAttempt({ attempt: first, outcome: "failed", failureReason: "payment_declined", source: "verify" });
    const { attempt: second } = await createPaymentAttempt({ agreementId, attemptNumber: 2, isRecovery: true, razorpayOrderId: "order_reused" });

    // Only ONE of the two (sharing the same order id) is ever "created" at a time.
    const found = await findUnresolvedAttemptByOrderId("order_reused");
    expect(found?.id).toBe(second.id);
    expect(found?.id).not.toBe(first.id);
  });
});

describe("resolvePaymentAttempt — the core state-transition function", () => {
  it("first attempt succeeding: PaymentAttempt->success, Agreement pending_payment->paid, PAYMENT_SUCCEEDED written", async () => {
    const { agreementId } = await createTestAgreement();
    const { attempt } = await createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_1" });

    const result = await resolvePaymentAttempt({ attempt, outcome: "success", razorpayPaymentId: "pay_1", source: "verify" });

    expect(result).toEqual({ applied: true, attemptStatus: "success", agreementStatus: "paid" });
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("paid");
    expect(await prisma.auditLog.count({ where: { paymentAttemptId: attempt.id, eventType: AUDIT_EVENT_PAYMENT_SUCCEEDED } })).toBe(1);
  });

  it("first attempt failing: PaymentAttempt->failed with reason, Agreement pending_payment->failed, PAYMENT_FAILED written", async () => {
    const { agreementId } = await createTestAgreement();
    const { attempt } = await createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_1" });

    const result = await resolvePaymentAttempt({ attempt, outcome: "failed", failureReason: "payment_declined", source: "verify" });

    expect(result).toEqual({ applied: true, attemptStatus: "failed", agreementStatus: "failed" });
    const stored = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(stored.failureReason).toBe("payment_declined");
    expect(await prisma.auditLog.count({ where: { paymentAttemptId: attempt.id, eventType: AUDIT_EVENT_PAYMENT_FAILED } })).toBe(1);
  });

  it("a recovery attempt succeeding: Agreement failed->recovered, RECOVERY_SUCCEEDED written", async () => {
    const { agreementId } = await createTestAgreement();
    const { attempt: first } = await createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_1" });
    await resolvePaymentAttempt({ attempt: first, outcome: "failed", failureReason: "payment_declined", source: "verify" });
    const { attempt: recovery } = await createPaymentAttempt({ agreementId, attemptNumber: 2, isRecovery: true, razorpayOrderId: "order_1" });

    const result = await resolvePaymentAttempt({ attempt: recovery, outcome: "success", razorpayPaymentId: "pay_2", source: "verify" });

    expect(result.agreementStatus).toBe("recovered");
    expect(await prisma.auditLog.count({ where: { paymentAttemptId: recovery.id, eventType: AUDIT_EVENT_RECOVERY_SUCCEEDED } })).toBe(1);
  });

  it("a recovery attempt also failing: Agreement REMAINS 'failed' (never a new/different status), RECOVERY_FAILED written", async () => {
    const { agreementId } = await createTestAgreement();
    const { attempt: first } = await createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_1" });
    await resolvePaymentAttempt({ attempt: first, outcome: "failed", failureReason: "payment_declined", source: "verify" });
    const { attempt: recovery } = await createPaymentAttempt({ agreementId, attemptNumber: 2, isRecovery: true, razorpayOrderId: "order_1" });

    const result = await resolvePaymentAttempt({ attempt: recovery, outcome: "failed", failureReason: "payment_declined", source: "verify" });

    expect(result.agreementStatus).toBe("failed");
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("failed");
    expect(await prisma.auditLog.count({ where: { paymentAttemptId: recovery.id, eventType: AUDIT_EVENT_RECOVERY_FAILED } })).toBe(1);
  });

  it("idempotent: resolving an already-settled attempt again is a no-op (applied=false), no duplicate AuditLog, no re-write", async () => {
    const { agreementId } = await createTestAgreement();
    const { attempt } = await createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_1" });

    const first = await resolvePaymentAttempt({ attempt, outcome: "success", razorpayPaymentId: "pay_1", source: "verify" });
    const second = await resolvePaymentAttempt({ attempt, outcome: "success", razorpayPaymentId: "pay_1", source: "webhook" });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.attemptStatus).toBe("success"); // reflects real current state
    expect(second.agreementStatus).toBe("paid");
    expect(await prisma.auditLog.count({ where: { paymentAttemptId: attempt.id, eventType: AUDIT_EVENT_PAYMENT_SUCCEEDED } })).toBe(1); // still exactly one
  });

  it("NEVER regresses a paid Agreement back to failed — a contradictory late report is a safe no-op", async () => {
    const { agreementId } = await createTestAgreement();
    const { attempt } = await createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_1" });
    await resolvePaymentAttempt({ attempt, outcome: "success", razorpayPaymentId: "pay_1", source: "verify" });

    // A stale/contradictory "failed" report for the SAME attempt arrives later (e.g. a delayed or out-of-order webhook).
    const result = await resolvePaymentAttempt({ attempt, outcome: "failed", failureReason: "payment_declined", source: "webhook" });

    expect(result.applied).toBe(false);
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("paid"); // unchanged — never regressed
  });

  it("success after a prior failure on the SAME (settled) attempt object is also a safe no-op — recovery is the correct path for that, not re-resolving attempt 1", async () => {
    const { agreementId } = await createTestAgreement();
    const { attempt } = await createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_1" });
    await resolvePaymentAttempt({ attempt, outcome: "failed", failureReason: "payment_declined", source: "verify" });

    const result = await resolvePaymentAttempt({ attempt, outcome: "success", razorpayPaymentId: "pay_1", source: "webhook" });

    expect(result.applied).toBe(false);
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("failed"); // unchanged by the stale success report on the settled attempt
  });
});

describe("webhook event idempotency (via AuditLog — no new table)", () => {
  it("hasWebhookEventBeenProcessed is false before any record, true after recordWebhookReceived", async () => {
    const { agreementId } = await createTestAgreement();
    expect(await hasWebhookEventBeenProcessed("evt_unique_1")).toBe(false);

    await recordWebhookReceived({ eventId: "evt_unique_1", eventType: "payment.captured", agreementId, rawPayload: { ok: true } });

    expect(await hasWebhookEventBeenProcessed("evt_unique_1")).toBe(true);
  });

  it("a different event id is never mistaken for a processed one", async () => {
    const { agreementId } = await createTestAgreement();
    await recordWebhookReceived({ eventId: "evt_a", eventType: "payment.captured", agreementId, rawPayload: {} });
    expect(await hasWebhookEventBeenProcessed("evt_b")).toBe(false);
  });

  it("records the WEBHOOK_RECEIVED AuditLog event type", async () => {
    const { agreementId } = await createTestAgreement();
    await recordWebhookReceived({ eventId: "evt_c", eventType: "payment.failed", agreementId, rawPayload: {} });
    const rows = await prisma.auditLog.findMany({ where: { agreementId, eventType: AUDIT_EVENT_WEBHOOK_RECEIVED } });
    expect(rows).toHaveLength(1);
  });
});

describe("listPaymentAttempts", () => {
  it("returns every attempt for an Agreement, oldest first", async () => {
    const { agreementId } = await createTestAgreement();
    await createPaymentAttempt({ agreementId, attemptNumber: 1, isRecovery: false, razorpayOrderId: "order_1" });
    await resolvePaymentAttempt({
      attempt: (await findUnresolvedAttempt(agreementId))!,
      outcome: "failed",
      failureReason: "payment_declined",
      source: "verify",
    });
    await createPaymentAttempt({ agreementId, attemptNumber: 2, isRecovery: true, razorpayOrderId: "order_1" });

    const attempts = await listPaymentAttempts(agreementId);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
  });
});
