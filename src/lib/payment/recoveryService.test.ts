import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createNegotiationSession } from "@/lib/negotiation/negotiationSessionRepository";
import { ensureAgreementForSession } from "@/lib/negotiation/agreementRepository";
import { getLlmProvider } from "@/lib/llm/provider";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import { createOrderForAgreement, verifyCheckoutPayment, AgreementNotEligibleError, AgreementNotFoundError } from "./paymentService";
import { RecoveryLimitExceededError, startRecovery } from "./recoveryService";
import { MOCK_VALID_SIGNATURE } from "@/types/payment";

vi.mock("@/lib/llm/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/provider")>();
  return { ...actual, getLlmProvider: vi.fn() };
});
const mockedGetLlmProvider = vi.mocked(getLlmProvider);

const LAPTOP_SKU = "LAPTOP-14-I5";
const ORIGINAL_ENV = { ...process.env };
let sessionIdsToClean: string[] = [];

beforeEach(() => {
  sessionIdsToClean = [];
  mockedGetLlmProvider.mockReturnValue({ generateAgentMessage: vi.fn().mockResolvedValue("mocked") });
  process.env = { ...ORIGINAL_ENV, PAYMENT_PROVIDER: "mock", NODE_ENV: "test" };
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
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

async function createTestAgreement(): Promise<string> {
  const constraints: BuyerConstraints = { sku: LAPTOP_SKU, quantity: 100, maxUnitPrice: 45000, deliveryDeadlineDays: 10 };
  const session = await createNegotiationSession(LAPTOP_SKU, constraints, 4);
  sessionIdsToClean.push(session.id);
  const { agreement } = await ensureAgreementForSession(session.id, { sku: LAPTOP_SKU, quantity: 100, unitPrice: 44719, deliveryDays: 5 });
  return agreement.id;
}

/** Runs attempt #1 through to a genuine failure, leaving the Agreement in the real "failed" state recovery requires. */
async function failFirstAttempt(agreementId: string): Promise<string> {
  const order = await createOrderForAgreement(agreementId);
  await verifyCheckoutPayment(agreementId, { razorpayOrderId: order.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });
  return order.razorpayOrderId;
}

describe("startRecovery", () => {
  it("throws AgreementNotFoundError for an unknown id", async () => {
    await expect(startRecovery("not-a-real-id")).rejects.toBeInstanceOf(AgreementNotFoundError);
  });

  it("rejects recovery for an Agreement that hasn't failed yet (still pending_payment)", async () => {
    const agreementId = await createTestAgreement();
    await expect(startRecovery(agreementId)).rejects.toBeInstanceOf(AgreementNotEligibleError);
  });

  it("rejects recovery for an Agreement that already succeeded", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await verifyCheckoutPayment(agreementId, { razorpayOrderId: order.razorpayOrderId, razorpayPaymentId: "p", razorpaySignature: MOCK_VALID_SIGNATURE });
    await expect(startRecovery(agreementId)).rejects.toBeInstanceOf(AgreementNotEligibleError);
  });

  it("starts a real, bounded recovery attempt (attemptNumber=2, isRecovery=true) for a genuinely failed Agreement", async () => {
    const agreementId = await createTestAgreement();
    await failFirstAttempt(agreementId);

    const recovery = await startRecovery(agreementId);

    expect(recovery.attemptNumber).toBe(2);
    expect(recovery.isRecovery).toBe(true);
    expect(recovery.maxAttempts).toBe(2);

    const rows = await prisma.paymentAttempt.findMany({ where: { agreementId }, orderBy: { attemptNumber: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[1].isRecovery).toBe(true);
  });

  it("REUSES the same Razorpay order id from the failed first attempt — never creates a second order when Razorpay semantics permit reuse (current docs: retry may use the same order_id)", async () => {
    const agreementId = await createTestAgreement();
    const firstOrderId = await failFirstAttempt(agreementId);

    const recovery = await startRecovery(agreementId);

    expect(recovery.razorpayOrderId).toBe(firstOrderId);
  });

  it("in mock mode, the recovery attempt's order response carries mockForceOutcome='success' — the demo's own deterministic second-attempt outcome", async () => {
    const agreementId = await createTestAgreement();
    await failFirstAttempt(agreementId);
    const recovery = await startRecovery(agreementId);
    expect(recovery.mockForceOutcome).toBe("success");
  });

  it("recovery succeeding moves the Agreement to 'recovered', not 'paid'", async () => {
    const agreementId = await createTestAgreement();
    await failFirstAttempt(agreementId);
    const recovery = await startRecovery(agreementId);

    const result = await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: recovery.razorpayOrderId,
      razorpayPaymentId: "pay_recovery",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });

    expect(result.agreementStatus).toBe("recovered");
  });

  it("rejects a second recovery once the 2-attempt bound has already been used", async () => {
    const agreementId = await createTestAgreement();
    await failFirstAttempt(agreementId);
    const recovery = await startRecovery(agreementId);
    // Fail the recovery attempt too, so the Agreement is "failed" again —
    // but the ATTEMPT COUNT (2) is what actually bounds recovery, not the status.
    await verifyCheckoutPayment(agreementId, { razorpayOrderId: recovery.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });

    await expect(startRecovery(agreementId)).rejects.toBeInstanceOf(RecoveryLimitExceededError);
  });

  it("a genuinely concurrent double-click on 'Retry payment' never creates a 3rd attempt — the deterministic-id guard applies here too", async () => {
    const agreementId = await createTestAgreement();
    await failFirstAttempt(agreementId);

    const results = await Promise.allSettled([startRecovery(agreementId), startRecovery(agreementId)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const rows = await prisma.paymentAttempt.findMany({ where: { agreementId } });
    expect(rows).toHaveLength(2); // attempt 1 (failed) + exactly one recovery attempt, never a 3rd
  });

  // Defensive-code coverage: a PaymentAttempt with no razorpayOrderId at
  // all cannot arise through the real API (createPaymentAttempt always
  // receives a real order id — see paymentService.ts's own
  // createRazorpayOrder, which never produces a durable PaymentAttempt
  // row on failure). This directly manufactures that state at the
  // repository level to prove the "genuinely new order" branch is
  // correct if it were ever reached, without dishonestly implying it's
  // reachable through startRecovery's own public precondition (Agreement
  // must be "failed", which — through the real API — only ever happens
  // once a real order already exists).
  it("creates a genuinely NEW Razorpay order only when the prior attempt has no order id to reuse (defensive branch, manufactured state)", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await verifyCheckoutPayment(agreementId, { razorpayOrderId: order.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });
    // Manufacture the edge case directly — never possible via the public
    // API (see this test's own comment above) — by clearing the order id
    // straight off the deterministic-id row paymentRepository.ts created.
    await prisma.paymentAttempt.update({ where: { id: `${agreementId}-attempt-1` }, data: { razorpayOrderId: null } });

    const recovery = await startRecovery(agreementId);

    expect(recovery.razorpayOrderId).toBeTruthy();
    expect(recovery.razorpayOrderId).not.toBe(order.razorpayOrderId); // genuinely new, nothing to reuse
    expect(recovery.razorpayOrderId).toMatch(/^order_mock_/);
  });
});

// M13.1 — the real-provider hardening: a recovery attempt that was
// created but never resolved (the browser crashed/errored before
// calling /verify, while Razorpay itself may have gone on to capture a
// real payment) must be RESUMABLE — calling startRecovery again must
// return the SAME attempt/order, never create a 3rd logical attempt.
describe("startRecovery — resuming an already-open (unresolved) recovery attempt", () => {
  it("a second startRecovery call, while attempt #2 is still 'created', returns the SAME attempt/order — never creates a 3rd", async () => {
    const agreementId = await createTestAgreement();
    await failFirstAttempt(agreementId);

    const first = await startRecovery(agreementId); // creates attempt #2
    const second = await startRecovery(agreementId); // must RESUME it, not create #3

    expect(second.attemptNumber).toBe(2);
    expect(second.razorpayOrderId).toBe(first.razorpayOrderId);
    expect(second.isRecovery).toBe(true);

    const rows = await prisma.paymentAttempt.findMany({ where: { agreementId } });
    expect(rows).toHaveLength(2); // attempt #1 (failed) + attempt #2 (still created) — never 3
  });

  it("resuming does not write a duplicate RECOVERY_STARTED AuditLog row", async () => {
    const agreementId = await createTestAgreement();
    await failFirstAttempt(agreementId);
    await startRecovery(agreementId);
    await startRecovery(agreementId); // resume

    const logs = await prisma.auditLog.findMany({ where: { agreementId, eventType: "RECOVERY_STARTED" } });
    expect(logs).toHaveLength(1);
  });

  it("resuming works even though attempts.length already equals MAX_LOGICAL_PAYMENT_ATTEMPTS — the exact real-provider scenario, not blocked by the bound check", async () => {
    const agreementId = await createTestAgreement();
    await failFirstAttempt(agreementId);
    await startRecovery(agreementId);

    const attemptsBefore = await prisma.paymentAttempt.count({ where: { agreementId } });
    expect(attemptsBefore).toBe(2); // already "at the bound" by count alone

    // Must NOT throw RecoveryLimitExceededError — the unresolved attempt
    // is resumable precisely because it was never actually resolved.
    const resumed = await startRecovery(agreementId);
    expect(resumed.attemptNumber).toBe(2);
    expect(await prisma.paymentAttempt.count({ where: { agreementId } })).toBe(2);
  });

  it("a resumed order response still carries the correct mock demo hint", async () => {
    const agreementId = await createTestAgreement();
    await failFirstAttempt(agreementId);
    await startRecovery(agreementId);

    const resumed = await startRecovery(agreementId);
    expect(resumed.mockForceOutcome).toBe("success");
  });

  it("resuming, then genuinely resolving the attempt, still reaches 'recovered' correctly (the fix doesn't change the eventual real outcome)", async () => {
    const agreementId = await createTestAgreement();
    await failFirstAttempt(agreementId);
    await startRecovery(agreementId);
    const resumed = await startRecovery(agreementId); // simulate a resumed session

    const result = await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: resumed.razorpayOrderId,
      razorpayPaymentId: "pay_resumed",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });

    expect(result.agreementStatus).toBe("recovered");
    expect(await prisma.paymentAttempt.count({ where: { agreementId } })).toBe(2); // still never a 3rd
  });

  it("multiple repeated resume calls (simulating several reloads of an interrupted page) never create additional rows", async () => {
    const agreementId = await createTestAgreement();
    await failFirstAttempt(agreementId);
    await startRecovery(agreementId);

    await startRecovery(agreementId);
    await startRecovery(agreementId);
    await startRecovery(agreementId);

    expect(await prisma.paymentAttempt.count({ where: { agreementId } })).toBe(2);
  });
});
