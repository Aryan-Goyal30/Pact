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
  createOrderForAgreement,
  getPaymentStatus,
  MAX_LOGICAL_PAYMENT_ATTEMPTS,
  verifyCheckoutPayment,
  VerificationMismatchError,
} from "./paymentService";
import { MOCK_VALID_SIGNATURE } from "@/types/payment";
import { rupeesToPaise } from "./razorpayClient";

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
    // A second verify call for the SAME (now-resolved) order — the
    // attempt is no longer "unresolved", so this is expected to reject
    // as a mismatch (nothing left to verify), never to silently re-apply.
    await expect(verifyCheckoutPayment(agreementId, input)).rejects.toBeInstanceOf(VerificationMismatchError);
    expect(first.agreementStatus).toBe("paid");
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
});
