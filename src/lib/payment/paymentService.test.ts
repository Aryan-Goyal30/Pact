// Real Prisma/SQLite dev database + the deterministic mock payment
// provider (never the real Razorpay SDK/network — see razorpayClient.ts's
// own env-var selection) — same scoped exception as agreementRepository.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createNegotiationSession } from "@/lib/negotiation/negotiationSessionRepository";
import { ensureAgreementForSession } from "@/lib/negotiation/agreementRepository";
import { getLlmProvider } from "@/lib/llm/provider";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import {
  AgreementNotEligibleError,
  AgreementNotFoundError,
  computeRecoveryAvailability,
  createOrderForAgreement,
  getPaymentStatus,
  MAX_LOGICAL_PAYMENT_ATTEMPTS,
  reportCheckoutFailure,
  verifyCheckoutPayment,
  VerificationMismatchError,
} from "./paymentService";
import { AUDIT_EVENT_PAYMENT_FAILURE_REPORTED } from "./paymentRepository";
import { startRecovery } from "./recoveryService";
import { MOCK_VALID_SIGNATURE } from "@/types/payment";
import { rupeesToPaise } from "./razorpayClient";
import type { PaymentAttemptRow } from "./paymentRepository";

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

async function createTestAgreement(unitPrice = 44719, quantity = 100): Promise<{ agreementId: string; totalAmount: number }> {
  const constraints: BuyerConstraints = { sku: LAPTOP_SKU, quantity, maxUnitPrice: 45000, deliveryDeadlineDays: 10 };
  const session = await createNegotiationSession(LAPTOP_SKU, constraints, 4);
  sessionIdsToClean.push(session.id);
  const { agreement } = await ensureAgreementForSession(session.id, { sku: LAPTOP_SKU, quantity, unitPrice, deliveryDays: 5 });
  return { agreementId: agreement.id, totalAmount: agreement.totalAmount };
}

describe("createOrderForAgreement", () => {
  it("throws AgreementNotFoundError for an unknown id", async () => {
    await expect(createOrderForAgreement("not-a-real-id")).rejects.toBeInstanceOf(AgreementNotFoundError);
  });

  it("creates a real PaymentAttempt row and derives the amount ONLY from Agreement.totalAmount — never a client-supplied amount, since none can even be passed", async () => {
    const { agreementId, totalAmount } = await createTestAgreement();

    const order = await createOrderForAgreement(agreementId);

    expect(order.amount).toBe(rupeesToPaise(totalAmount));
    expect(order.currency).toBe("INR");
    expect(order.attemptNumber).toBe(1);
    expect(order.isRecovery).toBe(false);
    expect(order.razorpayOrderId).toMatch(/^order_mock_/);
    // Milestone's own worked example, re-derived from a real Agreement: 100 * 44719 = 4471900 rupees -> 447190000 paise.
    expect(totalAmount).toBe(4471900);
    expect(order.amount).toBe(447190000);
  });

  it("in mock mode, the first attempt's order response carries mockForceOutcome='failure' (the demo's own deterministic sequence)", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    expect(order.mockForceOutcome).toBe("failure");
  });

  it("never includes keySecret or any secret-shaped field in the response", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    const serialized = JSON.stringify(order);
    expect(serialized).not.toMatch(/secret/i);
  });

  it("is idempotent under a duplicate request (double-click): the SAME order/attempt is returned, no second PaymentAttempt row", async () => {
    const { agreementId } = await createTestAgreement();

    const first = await createOrderForAgreement(agreementId);
    const second = await createOrderForAgreement(agreementId);

    expect(second.razorpayOrderId).toBe(first.razorpayOrderId);
    const rows = await prisma.paymentAttempt.findMany({ where: { agreementId } });
    expect(rows).toHaveLength(1);
  });

  it("is safe under a genuinely concurrent request: at most one PaymentAttempt row is ever created", async () => {
    const { agreementId } = await createTestAgreement();

    // 2 concurrent callers — the realistic double-click shape; see
    // paymentRepository.test.ts's own comment on why a wider synthetic
    // fan-out isn't needed to prove this and can spuriously time out
    // under the full suite's combined SQLite write load.
    const orders = await Promise.all(Array.from({ length: 2 }, () => createOrderForAgreement(agreementId)));

    const orderIds = new Set(orders.map((o) => o.razorpayOrderId));
    expect(orderIds.size).toBe(1); // every concurrent caller sees the same order
    const rows = await prisma.paymentAttempt.findMany({ where: { agreementId } });
    expect(rows).toHaveLength(1);
  });

  it("rejects creating a fresh order for an Agreement that already reached a terminal payment status", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "pay_1",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });
    // Agreement is now "paid" — a fresh (non-replay) order request must be rejected.
    await expect(createOrderForAgreement(agreementId)).rejects.toBeInstanceOf(AgreementNotEligibleError);
  });
});

describe("verifyCheckoutPayment", () => {
  // M13.1 §7 — a reported failure's own payment_id (when Razorpay's real
  // event carried one) reaches the AuditLog payload, purely for
  // reconciliation visibility — never used to decide anything, and the
  // failure resolution itself still requires no proof, exactly as before.
  it("M13.1: forwards a reported failure's payment_id into the AuditLog payload, audit-only", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      reportedFailureCode: "GATEWAY_ERROR",
      reportedPaymentId: "pay_real_but_declined",
    });

    const log = await prisma.auditLog.findFirstOrThrow({ where: { agreementId, eventType: "PAYMENT_FAILED" } });
    const payload = JSON.parse(log.payload) as Record<string, unknown>;
    expect(payload.razorpayPaymentId).toBe("pay_real_but_declined");
    // Still classified via the closed taxonomy, still no proof required —
    // this field changes nothing about the resolution itself.
    expect(payload.outcome).toBe("failed");
  });

  it("omits razorpayPaymentId from the payload entirely when none was reported (unchanged, pre-existing behavior)", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    await verifyCheckoutPayment(agreementId, { razorpayOrderId: order.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });

    const log = await prisma.auditLog.findFirstOrThrow({ where: { agreementId, eventType: "PAYMENT_FAILED" } });
    const payload = JSON.parse(log.payload) as Record<string, unknown>;
    expect(payload.razorpayPaymentId).toBeUndefined();
  });

  it("marks the Agreement 'paid' on a genuinely valid signature", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    const result = await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "pay_1",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });

    expect(result.attemptStatus).toBe("success");
    expect(result.agreementStatus).toBe("paid");
  });

  it("NEVER marks 'paid' on an invalid signature — classified verification_failed", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    const result = await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "pay_1",
      razorpaySignature: "forged-signature",
    });

    expect(result.attemptStatus).toBe("failed");
    expect(result.failureReason).toBe("verification_failed");
    expect(result.agreementStatus).toBe("failed");
  });

  it("a reported client-side failure (no signature) is recorded without requiring any proof", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    const result = await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      reportedFailureCode: "GATEWAY_ERROR",
    });

    expect(result.attemptStatus).toBe("failed");
    expect(result.failureReason).toBe("payment_declined");
  });

  it("rejects a razorpayOrderId that doesn't match this Agreement's own unresolved attempt (wrong order/agreement combination)", async () => {
    const { agreementId } = await createTestAgreement();
    await createOrderForAgreement(agreementId);

    await expect(
      verifyCheckoutPayment(agreementId, {
        razorpayOrderId: "order_mock_someone_elses_order",
        razorpayPaymentId: "pay_1",
        razorpaySignature: MOCK_VALID_SIGNATURE,
      }),
    ).rejects.toBeInstanceOf(VerificationMismatchError);
  });

  it("rejects verification when no order was ever created for this Agreement", async () => {
    const { agreementId } = await createTestAgreement();
    await expect(
      verifyCheckoutPayment(agreementId, { razorpayOrderId: "order_never_created", razorpayPaymentId: "p", razorpaySignature: "s" }),
    ).rejects.toBeInstanceOf(VerificationMismatchError);
  });

  it("duplicate verification of the same successful attempt is idempotent — reports the same real outcome, never double-charges/double-writes", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    const input = { razorpayOrderId: order.razorpayOrderId, razorpayPaymentId: "pay_1", razorpaySignature: MOCK_VALID_SIGNATURE };

    const first = await verifyCheckoutPayment(agreementId, input);
    // Pass 7: a second verify call for the SAME (now-resolved) order —
    // the attempt is no longer "unresolved" via the primary lookup, but
    // the success-claim fallback still finds it (see
    // findResolvableAttemptForSuccess's own doc comment), and
    // resolvePaymentAttempt's own guard makes re-applying it a safe
    // no-op — this now genuinely IS idempotent, reporting the same real
    // outcome rather than throwing.
    const second = await verifyCheckoutPayment(agreementId, input);
    expect(first.agreementStatus).toBe("paid");
    expect(second.agreementStatus).toBe("paid");
    expect(await prisma.auditLog.count({ where: { agreementId, eventType: "PAYMENT_SUCCEEDED" } })).toBe(1); // never double-written
  });

  it("recoveryAvailable is true after the first attempt fails, and reflects MAX_LOGICAL_PAYMENT_ATTEMPTS", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    const result = await verifyCheckoutPayment(agreementId, { razorpayOrderId: order.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });

    expect(result.recoveryAvailable).toBe(true);
    expect(MAX_LOGICAL_PAYMENT_ATTEMPTS).toBe(2);
  });
});

describe("getPaymentStatus", () => {
  it("throws AgreementNotFoundError for an unknown id", async () => {
    await expect(getPaymentStatus("not-a-real-id")).rejects.toBeInstanceOf(AgreementNotFoundError);
  });

  it("reports pending_payment with no attempts before any order is created", async () => {
    const { agreementId } = await createTestAgreement();
    const status = await getPaymentStatus(agreementId);
    expect(status.agreementStatus).toBe("pending_payment");
    expect(status.attempts).toHaveLength(0);
    expect(status.recoveryAvailable).toBe(false);
    expect(status.maxAttempts).toBe(2);
  });

  it("reflects a real attempt's status and failure reason after a failed payment", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await verifyCheckoutPayment(agreementId, { razorpayOrderId: order.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });

    const status = await getPaymentStatus(agreementId);
    expect(status.agreementStatus).toBe("failed");
    expect(status.attempts).toEqual([{ attemptNumber: 1, isRecovery: false, status: "failed", failureReason: "payment_declined" }]);
    expect(status.recoveryAvailable).toBe(true);
  });

  it("never leaks a secret or signature in the status summary", async () => {
    const { agreementId } = await createTestAgreement();
    await createOrderForAgreement(agreementId);
    const serialized = JSON.stringify(await getPaymentStatus(agreementId));
    expect(serialized).not.toMatch(/secret|signature/i);
  });

  // M13.1 — the exact real-provider regression: Attempt #1 failed,
  // Attempt #2 created (never resolved) must still report as resumable,
  // not exhausted. This is the precise state a real Razorpay Test Mode
  // session produced (order Paid, attempt #2 stuck "created") that the
  // pre-M13.1 `attempts.length < MAX` check got wrong.
  it("M13.1: Attempt #1 failed + Attempt #2 created (unresolved) → recoveryAvailable = true", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await verifyCheckoutPayment(agreementId, { razorpayOrderId: order.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });
    await startRecovery(agreementId); // creates attempt #2, deliberately left unresolved

    const status = await getPaymentStatus(agreementId);

    expect(status.agreementStatus).toBe("failed");
    expect(status.attempts).toEqual([
      { attemptNumber: 1, isRecovery: false, status: "failed", failureReason: "payment_declined" },
      { attemptNumber: 2, isRecovery: true, status: "created" },
    ]);
    expect(status.recoveryAvailable).toBe(true); // the actual real-provider fix
    expect(status.currentRazorpayOrderId).toBe(order.razorpayOrderId);
  });
});

describe("computeRecoveryAvailability — the one shared semantic (M13.1)", () => {
  function attempt(overrides: Partial<PaymentAttemptRow>): PaymentAttemptRow {
    return {
      id: "a",
      agreementId: "ag",
      attemptNumber: 1,
      isRecovery: false,
      razorpayOrderId: "order_x",
      status: "failed",
      failureReason: null,
      createdAt: new Date(),
      ...overrides,
    };
  }

  it("is false whenever the Agreement isn't 'failed', regardless of attempts", () => {
    expect(computeRecoveryAvailability("pending_payment", [])).toBe(false);
    expect(computeRecoveryAvailability("paid", [attempt({ status: "success" })])).toBe(false);
    expect(computeRecoveryAvailability("recovered", [attempt({ status: "success", isRecovery: true })])).toBe(false);
    expect(computeRecoveryAvailability("closed", [])).toBe(false);
  });

  it("is true when a 'created' (unresolved) attempt exists, EVEN AT the attempt-count bound — the real-provider fix", () => {
    const attempts = [
      attempt({ attemptNumber: 1, isRecovery: false, status: "failed" }),
      attempt({ attemptNumber: 2, isRecovery: true, status: "created" }), // exactly the real Razorpay scenario
    ];
    expect(attempts.length).toBe(MAX_LOGICAL_PAYMENT_ATTEMPTS); // confirms this is genuinely "at the bound"
    expect(computeRecoveryAvailability("failed", attempts)).toBe(true);
  });

  it("is true when failed with room left under the bound and nothing unresolved (the ordinary case, unchanged)", () => {
    expect(computeRecoveryAvailability("failed", [attempt({ status: "failed" })])).toBe(true);
  });

  it("is false when failed, nothing unresolved, and the bound is genuinely used up by TERMINAL attempts", () => {
    const attempts = [
      attempt({ attemptNumber: 1, isRecovery: false, status: "failed" }),
      attempt({ attemptNumber: 2, isRecovery: true, status: "failed" }), // both terminal — genuinely exhausted
    ];
    expect(computeRecoveryAvailability("failed", attempts)).toBe(false);
  });

  it("never returns true in a way that would let a 3rd attempt be created — this function only reports resumability, it does not itself create anything", () => {
    // Documents the contract: true here means "resume the existing
    // unresolved row OR start a new one within the bound" — never
    // "create a 3rd, regardless." recoveryService.ts's own resume
    // branch (tested separately) is what actually enforces this.
    const attempts = [
      attempt({ attemptNumber: 1, isRecovery: false, status: "failed" }),
      attempt({ attemptNumber: 2, isRecovery: true, status: "created" }),
    ];
    expect(computeRecoveryAvailability("failed", attempts)).toBe(true);
    expect(attempts).toHaveLength(2); // still exactly 2 — this function never mutates anything
  });
});

// M13.2 — the real-provider fix: a browser-observed Razorpay Checkout
// `payment.failed` event must be recorded for audit purposes but must
// NEVER terminalize the PaymentAttempt/Agreement, since Razorpay's own
// Checkout retry (enabled by default) may still succeed against the same
// order afterward. See paymentRepository.ts's recordReportedCheckoutFailure
// and PaymentPanel.tsx's own header comments for the full reasoning.
describe("reportCheckoutFailure — M13.2 informational-only failure reporting", () => {
  it("does NOT change PaymentAttempt or Agreement status (A)", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    await reportCheckoutFailure(agreementId, { razorpayOrderId: order.razorpayOrderId, errorCode: "BAD_OTP" });

    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { agreementId } });
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(attempt.status).toBe("created"); // still unresolved
    expect(attempt.failureReason).toBeNull();
    expect(agreement.status).toBe("pending_payment"); // never moved to "failed"
  });

  it("records a PAYMENT_FAILURE_REPORTED AuditLog row linked to the still-unresolved attempt", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    await reportCheckoutFailure(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      errorCode: "BAD_OTP",
      errorDescription: "OTP incorrect",
      reportedPaymentId: "pay_declined_1",
    });

    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { agreementId } });
    const logs = await prisma.auditLog.findMany({ where: { agreementId, eventType: AUDIT_EVENT_PAYMENT_FAILURE_REPORTED } });
    expect(logs).toHaveLength(1);
    expect(logs[0].paymentAttemptId).toBe(attempt.id);
    const payload = JSON.parse(logs[0].payload) as { errorCode?: string; reportedPaymentId?: string };
    expect(payload.errorCode).toBe("BAD_OTP");
    expect(payload.reportedPaymentId).toBe("pay_declined_1");
  });

  it("multiple payment.failed events for the SAME still-open attempt each produce their own audit row, never overwriting one another (B, E)", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    await reportCheckoutFailure(agreementId, { razorpayOrderId: order.razorpayOrderId, errorCode: "BAD_OTP" });
    await reportCheckoutFailure(agreementId, { razorpayOrderId: order.razorpayOrderId, errorCode: "INSUFFICIENT_FUNDS" });
    await reportCheckoutFailure(agreementId, { razorpayOrderId: order.razorpayOrderId, errorCode: "CARD_DECLINED" });

    const logs = await prisma.auditLog.findMany({ where: { agreementId, eventType: AUDIT_EVENT_PAYMENT_FAILURE_REPORTED } });
    expect(logs).toHaveLength(3);
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { agreementId } });
    expect(attempt.status).toBe("created"); // still one single unresolved attempt throughout
  });

  it("a later genuine success still resolves the SAME attempt to paid, even after earlier payment.failed reports (C, D, K — the exact real-provider regression this milestone fixes)", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    // Two declines inside a still-open Checkout session (Razorpay's own
    // native retry) — must not foreclose the later success below.
    await reportCheckoutFailure(agreementId, { razorpayOrderId: order.razorpayOrderId, errorCode: "BAD_OTP" });
    await reportCheckoutFailure(agreementId, { razorpayOrderId: order.razorpayOrderId, errorCode: "CARD_DECLINED" });

    const result = await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "pay_eventual_success",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });

    expect(result.agreementStatus).toBe("paid");
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("paid");
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { agreementId } });
    expect(attempt.status).toBe("success");

    // Exactly ONE PaymentAttempt and ONE Razorpay order throughout — the
    // native retries never created a second logical attempt.
    expect(await prisma.paymentAttempt.count({ where: { agreementId } })).toBe(1);

    // Earlier failure reports are still preserved in the audit trail
    // alongside the eventual success (E).
    const logs = (await prisma.auditLog.findMany({ where: { agreementId }, orderBy: { createdAt: "asc" } })).map((l) => l.eventType);
    expect(logs.filter((e) => e === AUDIT_EVENT_PAYMENT_FAILURE_REPORTED)).toHaveLength(2);
    expect(logs).toContain("PAYMENT_SUCCEEDED");
  });

  it("never throws for a mismatched/stale order id — still records, unlinked, rather than rejecting", async () => {
    const { agreementId } = await createTestAgreement();
    await createOrderForAgreement(agreementId);

    await expect(
      reportCheckoutFailure(agreementId, { razorpayOrderId: "order_totally_different_stale", errorCode: "BAD_OTP" }),
    ).resolves.toBeUndefined();

    const logs = await prisma.auditLog.findMany({ where: { agreementId, eventType: AUDIT_EVENT_PAYMENT_FAILURE_REPORTED } });
    expect(logs).toHaveLength(1);
    expect(logs[0].paymentAttemptId).toBeNull(); // correctly unlinked — no attempt actually matched
  });

  it("never throws when there is no unresolved attempt at all (e.g. already resolved) — still records", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "p",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    }); // already resolved to paid

    await expect(
      reportCheckoutFailure(agreementId, { razorpayOrderId: order.razorpayOrderId, errorCode: "STALE_EVENT" }),
    ).resolves.toBeUndefined();

    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("paid"); // completely unaffected
  });

  it("404s (AgreementNotFoundError) for a genuinely unknown Agreement id", async () => {
    await expect(reportCheckoutFailure("not-a-real-id", { razorpayOrderId: "order_x" })).rejects.toBeInstanceOf(AgreementNotFoundError);
  });
});

// ---------------------------------------------------------------------
// Pass 7: payment recovery hardening — the real bug this pass fixes:
// "A failed ATTEMPT is not necessarily a failed ORDER." A genuine
// success for the SAME Razorpay order must still resolve the Agreement
// to paid even after an earlier failure was recorded against the same
// attempt — never a permanent "No matching unresolved payment attempt"
// dead end.
// ---------------------------------------------------------------------
describe("verifyCheckoutPayment — Pass 7: success after failure on the SAME order", () => {
  // 1 / 3. failure -> success on the SAME order resolves to paid.
  it("a genuine success after an earlier reported failure on the SAME order resolves the Agreement to paid", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    const failure = await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      reportedFailureCode: "GATEWAY_ERROR",
    });
    expect(failure.agreementStatus).toBe("failed");

    // The SAME order, now a genuine signed success (Razorpay's own
    // in-Checkout retry against the still-open order).
    const success = await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "pay_retry_success",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });

    expect(success.agreementStatus).toBe("paid");
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("paid");
    // Resolved the SAME attempt in place — never a second row.
    expect(await prisma.paymentAttempt.count({ where: { agreementId } })).toBe(1);
  });

  // 2. Failure does not permanently terminate recoverability — the
  // agreement stays reachable via the SAME order even without an
  // explicit /recover call, since recovery only matters when a genuinely
  // NEW attempt/order is needed (never the case here).
  it("recoveryAvailable is still reported true after the failure, and the SAME order remains valid for the eventual success", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await verifyCheckoutPayment(agreementId, { razorpayOrderId: order.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });

    const status = await getPaymentStatus(agreementId);
    expect(status.recoveryAvailable).toBe(true);

    const success = await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId, // the SAME order, not a new recovery order
      razorpayPaymentId: "pay_2",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });
    expect(success.agreementStatus).toBe("paid");
  });

  // 10. Invalid signature still cannot mark paid, even via the new
  // fallback path onto a previously-failed attempt.
  it("an invalid signature after a prior failure still cannot mark the Agreement paid", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await verifyCheckoutPayment(agreementId, { razorpayOrderId: order.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });

    const result = await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "pay_forged",
      razorpaySignature: "definitely-not-valid",
    });

    expect(result.attemptStatus).toBe("failed");
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("failed"); // never paid
  });

  // 11. Wrong order_id still cannot resolve the Agreement, even via the
  // new fallback path — the fallback requires an EXACT (agreementId,
  // razorpayOrderId) match, never a bare agreement-only lookup.
  it("a genuine success submitted with a DIFFERENT order id (not the failed attempt's own) is still rejected", async () => {
    const { agreementId } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await verifyCheckoutPayment(agreementId, { razorpayOrderId: order.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });

    await expect(
      verifyCheckoutPayment(agreementId, {
        razorpayOrderId: "order_completely_different",
        razorpayPaymentId: "pay_x",
        razorpaySignature: MOCK_VALID_SIGNATURE,
      }),
    ).rejects.toBeInstanceOf(VerificationMismatchError);

    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("failed"); // unchanged
  });

  // 12. verify's own request contract has no amount field at all —
  // structurally nothing to mismatch. Extra/unrelated body fields are
  // ignored, same discipline as the existing "Agreement terms cannot be
  // overridden" security test.
  it("has no amount field in its contract — an agreement can only ever reach paid via its own server-derived totalAmount", async () => {
    const { agreementId, totalAmount } = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    expect(order.amount).toBe(rupeesToPaise(totalAmount));

    await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "p",
      razorpaySignature: MOCK_VALID_SIGNATURE,
      // @ts-expect-error — intentionally probing an unsupported field; VerifyCheckoutInput has no `amount`.
      amount: 1,
    });

    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("paid");
    expect(agreement.totalAmount).toBe(totalAmount); // untouched by the bogus field
  });
});
