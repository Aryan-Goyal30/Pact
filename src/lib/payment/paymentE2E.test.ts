// End-to-end tests — PACT V2 Milestone 13. Real orchestrator (negotiation
// core, completely untouched by this milestone), real Prisma/SQLite dev
// database, real payment service/repository code — the ONLY thing ever
// mocked is the LLM boundary (getLlmProvider, the same boundary every
// other orchestrator test in this codebase already mocks) and the
// Razorpay network call (via PAYMENT_PROVIDER=mock — never a real
// network dependency, per this milestone's own explicit requirement that
// E2E tests use the deterministic mock adapter).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { runNegotiationToCompletion, type NegotiationContext } from "@/lib/negotiation/orchestrator";
import { ensureAgreementForSession } from "@/lib/negotiation/agreementRepository";
import { getLlmProvider } from "@/lib/llm/provider";
import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import type { PublicManifestProduct } from "@/types/manifest";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import { createOrderForAgreement, reportCheckoutFailure, verifyCheckoutPayment } from "@/lib/payment/paymentService";
import { startRecovery } from "@/lib/payment/recoveryService";
import { MOCK_VALID_SIGNATURE } from "@/types/payment";

vi.mock("@/lib/llm/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/provider")>();
  return { ...actual, getLlmProvider: vi.fn() };
});
const mockedGetLlmProvider = vi.mocked(getLlmProvider);

const LAPTOP_SKU = "LAPTOP-14-I5";
const ORIGINAL_ENV = { ...process.env };
let sessionIdsToClean: string[] = [];

const laptop: CatalogItemSnapshot = {
  sku: LAPTOP_SKU,
  listedPrice: 48000,
  minPrice: 44000,
  availableQty: 100,
  standardDeliveryDays: 5,
  maxDeliveryDays: 12,
  negotiationEnabled: true,
};
const laptopListing: PublicManifestProduct = {
  sku: LAPTOP_SKU,
  name: "14-inch Business Laptop (i5, 16GB RAM)",
  description: "Mid-range business laptop suitable for office use.",
  listedPrice: 48000,
  availableQuantity: 100,
  standardDeliveryDays: 5,
  maxDeliveryDays: 12,
  negotiable: true,
};

beforeEach(() => {
  sessionIdsToClean = [];
  mockedGetLlmProvider.mockReturnValue({ generateAgentMessage: vi.fn().mockResolvedValue("mocked agent message") });
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

async function negotiateToAgreement(buyerConstraints: BuyerConstraints, maxRounds = 4) {
  const { createNegotiationSession } = await import("@/lib/negotiation/negotiationSessionRepository");
  const session = await createNegotiationSession(LAPTOP_SKU, buyerConstraints, maxRounds);
  sessionIdsToClean.push(session.id);

  const context: NegotiationContext = { item: laptop, manifestProduct: laptopListing, buyerConstraints };
  const { finalState, transcript } = await runNegotiationToCompletion(context, maxRounds);
  expect(finalState.status).toBe("AGREED");
  const closingTurn = transcript[transcript.length - 1];

  const { agreement } = await ensureAgreementForSession(session.id, {
    sku: LAPTOP_SKU,
    quantity: closingTurn.merchant.quantity as number,
    unitPrice: closingTurn.merchant.unitPrice as number,
    deliveryDays: closingTurn.merchant.deliveryDays as number,
  });

  return { agreement, session };
}

// A. Happy path: negotiation -> Agreement -> Razorpay order -> checkout
// -> verification -> PAID.
describe("E2E A: negotiation -> Agreement -> order -> checkout -> verification -> PAID", () => {
  it("reaches a real, persisted 'paid' Agreement through the complete real flow", async () => {
    const { agreement } = await negotiateToAgreement({
      sku: LAPTOP_SKU,
      quantity: 10,
      maxUnitPrice: 48000, // meets listed price -> a quick, deterministic AGREED
      deliveryDeadlineDays: 5,
    });
    expect(agreement.status).toBe("pending_payment");

    // "Checkout" — mock mode, so this simulates what a real Checkout.js
    // handler(response) call would deliver, using the sentinel the mock
    // provider's own verifyCheckoutSignature recognizes.
    const order = await createOrderForAgreement(agreement.id);
    const result = await verifyCheckoutPayment(agreement.id, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "pay_e2e_success",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });

    expect(result.agreementStatus).toBe("paid");
    const persisted = await prisma.agreement.findUniqueOrThrow({ where: { id: agreement.id } });
    expect(persisted.status).toBe("paid");

    // Negotiated terms are byte-for-byte unchanged by payment — the
    // core product boundary this milestone must never cross.
    expect(persisted.quantity).toBe(agreement.quantity);
    expect(persisted.pricePerUnit).toBe(agreement.unitPrice);
    expect(persisted.deliveryDays).toBe(agreement.deliveryDays);
    expect(persisted.totalAmount).toBe(agreement.totalAmount);
  });
});

// B. Failure/recovery path: negotiation -> Agreement -> order -> failure
// -> retry -> recovery -> success -> RECOVERED.
describe("E2E B: negotiation -> Agreement -> order -> failure -> retry -> recovery -> success -> RECOVERED", () => {
  it("reaches a real, persisted 'recovered' Agreement through the complete real flow, using the SAME Agreement throughout", async () => {
    const { agreement } = await negotiateToAgreement({
      sku: LAPTOP_SKU,
      quantity: 10,
      maxUnitPrice: 48000,
      deliveryDeadlineDays: 5,
    });

    // First logical attempt — deliberately forced to fail (a
    // client-reported checkout failure, needing no signature).
    const order = await createOrderForAgreement(agreement.id);
    const failure = await verifyCheckoutPayment(agreement.id, {
      razorpayOrderId: order.razorpayOrderId,
      reportedFailureCode: "GATEWAY_ERROR",
    });
    expect(failure.agreementStatus).toBe("failed");
    expect(failure.recoveryAvailable).toBe(true);

    // "PACT detects it" — the Agreement itself, durably, already reflects this.
    const afterFailure = await prisma.agreement.findUniqueOrThrow({ where: { id: agreement.id } });
    expect(afterFailure.status).toBe("failed");

    // User-triggered retry.
    const recovery = await startRecovery(agreement.id);
    expect(recovery.attemptNumber).toBe(2);
    expect(recovery.isRecovery).toBe(true);
    expect(recovery.razorpayOrderId).toBe(order.razorpayOrderId); // same Razorpay order reused, per current Razorpay retry semantics

    const success = await verifyCheckoutPayment(agreement.id, {
      razorpayOrderId: recovery.razorpayOrderId,
      razorpayPaymentId: "pay_e2e_recovered",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });

    expect(success.agreementStatus).toBe("recovered");
    const persisted = await prisma.agreement.findUniqueOrThrow({ where: { id: agreement.id } });
    expect(persisted.status).toBe("recovered");
    expect(persisted.id).toBe(agreement.id); // the SAME Agreement throughout — never a second one, never a reopened negotiation

    // Exactly 2 PaymentAttempt rows total — the bounded recovery limit.
    const attempts = await prisma.paymentAttempt.findMany({ where: { agreementId: agreement.id }, orderBy: { attemptNumber: "asc" } });
    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe("failed");
    expect(attempts[1].status).toBe("success");
    expect(attempts[1].isRecovery).toBe(true);

    // A full, real audit trail exists for the whole sequence.
    const events = (await prisma.auditLog.findMany({ where: { agreementId: agreement.id }, orderBy: { createdAt: "asc" } })).map(
      (log) => log.eventType,
    );
    expect(events).toEqual([
      "AGREEMENT_CREATED",
      "PAYMENT_ORDER_CREATED",
      "PAYMENT_VERIFICATION_STARTED",
      "PAYMENT_FAILED",
      "RECOVERY_STARTED",
      "PAYMENT_VERIFICATION_STARTED",
      "RECOVERY_SUCCEEDED",
    ]);
  });

  it("negotiation terms are never modified by the failure/recovery cycle", async () => {
    const { agreement } = await negotiateToAgreement({
      sku: LAPTOP_SKU,
      quantity: 10,
      maxUnitPrice: 48000,
      deliveryDeadlineDays: 5,
    });
    const originalQuantity = agreement.quantity;
    const originalPrice = agreement.unitPrice;
    const originalDelivery = agreement.deliveryDays;

    const order = await createOrderForAgreement(agreement.id);
    await verifyCheckoutPayment(agreement.id, { razorpayOrderId: order.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });
    const recovery = await startRecovery(agreement.id);
    await verifyCheckoutPayment(agreement.id, {
      razorpayOrderId: recovery.razorpayOrderId,
      razorpayPaymentId: "p",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });

    const persisted = await prisma.agreement.findUniqueOrThrow({ where: { id: agreement.id } });
    expect(persisted.quantity).toBe(originalQuantity);
    expect(persisted.pricePerUnit).toBe(originalPrice);
    expect(persisted.deliveryDays).toBe(originalDelivery);
  });
});

// C. M13.2 — Razorpay's native in-Checkout retry path: negotiation ->
// Agreement -> order -> Checkout decline(s) reported (informational only,
// Razorpay's own modal stays open) -> a later success against the SAME
// order/attempt -> PAID. This is the automated-mock stand-in for the real
// Razorpay Test Mode walkthrough this milestone's own report performs
// live (PACT Pay Now -> Netbanking -> Test Bank FAILURE -> WITHOUT
// closing Checkout -> Razorpay's native Retry -> Test Bank SUCCESS).
describe("E2E C: negotiation -> Agreement -> order -> native in-Checkout retry -> success -> PAID (never a 2nd PaymentAttempt)", () => {
  it("resolves to paid through the SAME single PaymentAttempt/order, with every decline preserved as audit history", async () => {
    const { agreement } = await negotiateToAgreement({
      sku: LAPTOP_SKU,
      quantity: 10,
      maxUnitPrice: 48000,
      deliveryDeadlineDays: 5,
    });

    const order = await createOrderForAgreement(agreement.id);

    // Two declines inside what would be the SAME still-open real Checkout
    // session — informational only, never terminalizing.
    await reportCheckoutFailure(agreement.id, { razorpayOrderId: order.razorpayOrderId, errorCode: "BAD_OTP" });
    await reportCheckoutFailure(agreement.id, { razorpayOrderId: order.razorpayOrderId, errorCode: "CARD_DECLINED" });

    const midway = await prisma.agreement.findUniqueOrThrow({ where: { id: agreement.id } });
    expect(midway.status).toBe("pending_payment"); // never invented into "failed"

    // Razorpay's native retry eventually succeeds against the SAME order —
    // the same registered Checkout `handler` fires, forwarded to /verify.
    const result = await verifyCheckoutPayment(agreement.id, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "pay_e2e_native_retry_success",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });

    expect(result.agreementStatus).toBe("paid");
    const persisted = await prisma.agreement.findUniqueOrThrow({ where: { id: agreement.id } });
    expect(persisted.status).toBe("paid");

    // Exactly ONE PaymentAttempt and ONE Razorpay order for the whole
    // sequence — Razorpay's own retries never created a 2nd logical
    // attempt or a 2nd order, and no recovery attempt was ever started.
    const attempts = await prisma.paymentAttempt.findMany({ where: { agreementId: agreement.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("success");
    expect(attempts[0].razorpayOrderId).toBe(order.razorpayOrderId);

    // Both earlier declines are preserved in the audit trail alongside the
    // eventual success — informational history is never discarded.
    const events = (await prisma.auditLog.findMany({ where: { agreementId: agreement.id }, orderBy: { createdAt: "asc" } })).map(
      (log) => log.eventType,
    );
    expect(events.filter((e) => e === "PAYMENT_FAILURE_REPORTED")).toHaveLength(2);
    expect(events).toContain("PAYMENT_SUCCEEDED");
    expect(events).not.toContain("PAYMENT_FAILED"); // never a terminal-failure event for this attempt
  });
});
