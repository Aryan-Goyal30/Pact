import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { createNegotiationSession } from "@/lib/negotiation/negotiationSessionRepository";
import { ensureAgreementForSession } from "@/lib/negotiation/agreementRepository";
import { getLlmProvider } from "@/lib/llm/provider";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import { createOrderForAgreement, verifyCheckoutPayment } from "@/lib/payment/paymentService";
import { MOCK_VALID_SIGNATURE } from "@/types/payment";
import { POST } from "./route";

vi.mock("@/lib/llm/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/provider")>();
  return { ...actual, getLlmProvider: vi.fn() };
});
const mockedGetLlmProvider = vi.mocked(getLlmProvider);

const LAPTOP_SKU = "LAPTOP-14-I5";
const WEBHOOK_SECRET = "test_webhook_secret";
const ORIGINAL_ENV = { ...process.env };
let sessionIdsToClean: string[] = [];

beforeEach(() => {
  sessionIdsToClean = [];
  mockedGetLlmProvider.mockReturnValue({ generateAgentMessage: vi.fn().mockResolvedValue("mocked") });
  process.env = { ...ORIGINAL_ENV, PAYMENT_PROVIDER: "mock", NODE_ENV: "test", RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET };
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

function sign(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

function webhookPayload(event: string, orderId: string, paymentId: string, errorCode?: string): string {
  return JSON.stringify({
    event,
    payload: { payment: { entity: { id: paymentId, order_id: orderId, ...(errorCode ? { error_code: errorCode } : {}) } } },
  });
}

async function callWebhook(body: string, opts: { signature?: string; eventId?: string } = {}): Promise<Response> {
  const headers = new Headers();
  if (opts.signature !== undefined) headers.set("x-razorpay-signature", opts.signature);
  else headers.set("x-razorpay-signature", sign(body));
  if (opts.eventId !== undefined) headers.set("x-razorpay-event-id", opts.eventId);
  return POST(new Request("http://localhost/api/payments/webhook", { method: "POST", headers, body }));
}

describe("POST /api/payments/webhook", () => {
  it("400s when the signature header is missing", async () => {
    const body = webhookPayload("payment.captured", "order_x", "pay_x");
    const response = await POST(new Request("http://localhost/x", { method: "POST", body }));
    expect(response.status).toBe(400);
  });

  it("400s on an invalid signature", async () => {
    const body = webhookPayload("payment.captured", "order_x", "pay_x");
    const response = await callWebhook(body, { signature: "wrong-signature", eventId: "evt_1" });
    expect(response.status).toBe(400);
  });

  it("500s when RAZORPAY_WEBHOOK_SECRET is not configured", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const body = webhookPayload("payment.captured", "order_x", "pay_x");
    const response = await POST(new Request("http://localhost/x", { method: "POST", headers: { "x-razorpay-signature": "anything" }, body }));
    expect(response.status).toBe(500);
  });

  it("200s (no-op) for a validly-signed event whose order id matches no known attempt", async () => {
    const body = webhookPayload("payment.captured", "order_totally_unknown", "pay_x");
    const response = await callWebhook(body, { eventId: "evt_unknown_order" });
    expect(response.status).toBe(200);
  });

  it("a valid payment.captured event resolves the matching attempt to success and pays the Agreement", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    const body = webhookPayload("payment.captured", order.razorpayOrderId, "pay_1");

    const response = await callWebhook(body, { eventId: "evt_captured_1" });

    expect(response.status).toBe(200);
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("paid");
  });

  // Pass 7: a webhook payment.failed event is per-PAYMENT, not per-ORDER
  // — Razorpay's own Checkout retry may still succeed against the SAME
  // order, so this must be recorded for audit ONLY, never terminalize
  // the attempt/Agreement (mirrors recordReportedCheckoutFailure's own
  // M13.2 treatment of a browser-reported decline). This replaces the
  // pre-Pass-7 assertion that a webhook failure resolved the attempt to
  // "failed" — that was the exact real bug this pass fixes.
  it("a valid payment.failed event is recorded for audit only — the attempt/Agreement stay open, still resumable for a later genuine capture", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    const body = webhookPayload("payment.failed", order.razorpayOrderId, "pay_1", "GATEWAY_ERROR");

    await callWebhook(body, { eventId: "evt_failed_1" });

    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { agreementId } });
    expect(attempt.status).toBe("created"); // never terminalized
    expect(attempt.failureReason).toBeNull();
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("pending_payment"); // never terminalized
    const auditRows = await prisma.auditLog.findMany({ where: { agreementId, eventType: "PAYMENT_FAILURE_REPORTED" } });
    expect(auditRows).toHaveLength(1); // the decline is still preserved as history
  });

  it("a DUPLICATE delivery of the same event is a safe no-op — no double resolution, still 200", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    const body = webhookPayload("payment.captured", order.razorpayOrderId, "pay_1");

    const first = await callWebhook(body, { eventId: "evt_dup_1" });
    const second = await callWebhook(body, { eventId: "evt_dup_1" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { agreementId, eventType: "PAYMENT_SUCCEEDED" } })).toBe(1); // never double-applied
  });

  it("NEVER regresses an already-paid Agreement back to failed, even from a delayed/out-of-order webhook", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await callWebhook(webhookPayload("payment.captured", order.razorpayOrderId, "pay_1"), { eventId: "evt_success" });

    // A late, contradictory failure event for the SAME order arrives afterward.
    await callWebhook(webhookPayload("payment.failed", order.razorpayOrderId, "pay_1", "GATEWAY_ERROR"), { eventId: "evt_late_failure" });

    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("paid"); // unchanged
  });

  it("an unrecognized event type is recorded but never mistaken for a payment outcome", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    const body = webhookPayload("refund.processed", order.razorpayOrderId, "pay_1");

    const response = await callWebhook(body, { eventId: "evt_other" });

    expect(response.status).toBe(200);
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("pending_payment"); // untouched
  });
});

// ---------------------------------------------------------------------
// Pass 7: payment recovery hardening — the exact real-provider bug this
// pass fixes: PACT creates one order, Checkout fails, Razorpay/user
// retries within the SAME still-open order, payment succeeds — and PACT
// must NOT report "no matching unresolved payment attempt" for the
// genuine capture.
// ---------------------------------------------------------------------
describe("POST /api/payments/webhook — Pass 7: failure -> retry -> success on the SAME order", () => {
  // 1 / 3 / 7. The exact reported bug: webhook payment.failed, then
  // webhook payment.captured, for the SAME Razorpay order.
  it("payment.failed followed by payment.captured for the SAME order resolves the Agreement to paid — the exact real bug this pass fixes", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    const failedResponse = await callWebhook(
      webhookPayload("payment.failed", order.razorpayOrderId, "pay_1", "GATEWAY_ERROR"),
      { eventId: "evt_p7_failed" },
    );
    expect(failedResponse.status).toBe(200);

    const midway = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(midway.status).toBe("pending_payment"); // never terminalized by the decline

    const capturedResponse = await callWebhook(
      webhookPayload("payment.captured", order.razorpayOrderId, "pay_2_retry"),
      { eventId: "evt_p7_captured" },
    );
    expect(capturedResponse.status).toBe(200);

    const finalAgreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(finalAgreement.status).toBe("paid");
    // Exactly one PaymentAttempt/order throughout — no duplicate agreement,
    // no second attempt.
    expect(await prisma.paymentAttempt.count({ where: { agreementId } })).toBe(1);
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { agreementId } });
    expect(attempt.status).toBe("success");

    // Audit trail shows the full failure -> recovery/retry -> success
    // history, understandable and never silently discarded.
    const events = (
      await prisma.auditLog.findMany({ where: { agreementId }, orderBy: { createdAt: "asc" } })
    ).map((log) => log.eventType);
    expect(events).toContain("PAYMENT_FAILURE_REPORTED");
    expect(events).toContain("PAYMENT_SUCCEEDED");
    expect(events).not.toContain("PAYMENT_FAILED"); // never a terminal-failure event for this attempt
  });

  // 5. Webhook success arriving BEFORE the client's own /verify call for
  // the same order — the client call must then be a safe idempotent
  // no-op, never an error, never a second transition.
  it("webhook success before client verify success — the client call is a safe no-op reflecting the real state", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    await callWebhook(webhookPayload("payment.captured", order.razorpayOrderId, "pay_webhook_first"), {
      eventId: "evt_p7_webhook_first",
    });
    const afterWebhook = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(afterWebhook.status).toBe("paid");

    const clientResult = await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "pay_webhook_first",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });
    expect(clientResult.agreementStatus).toBe("paid"); // reflects real state, no error

    expect(await prisma.auditLog.count({ where: { agreementId, eventType: "PAYMENT_SUCCEEDED" } })).toBe(1); // never double-applied
  });

  // 6. Client verify success arriving BEFORE the webhook for the same
  // order — the webhook delivery must then be a safe idempotent no-op.
  it("client verify success before webhook success — the webhook delivery is a safe no-op", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    const clientResult = await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "pay_client_first",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });
    expect(clientResult.agreementStatus).toBe("paid");

    const webhookResponse = await callWebhook(
      webhookPayload("payment.captured", order.razorpayOrderId, "pay_client_first"),
      { eventId: "evt_p7_client_first" },
    );
    expect(webhookResponse.status).toBe(200);

    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("paid"); // unchanged
    expect(await prisma.auditLog.count({ where: { agreementId, eventType: "PAYMENT_SUCCEEDED" } })).toBe(1); // never double-applied
  });

  // 8. A late failure webhook arriving AFTER a valid capture must never
  // revert the paid Agreement — captured/paid is terminal.
  it("a late payment.failed webhook after a successful capture can never revert the paid Agreement", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    await callWebhook(webhookPayload("payment.captured", order.razorpayOrderId, "pay_1"), { eventId: "evt_p7_success" });
    const afterSuccess = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(afterSuccess.status).toBe("paid");

    await callWebhook(webhookPayload("payment.failed", order.razorpayOrderId, "pay_1", "GATEWAY_ERROR"), {
      eventId: "evt_p7_late_failure",
    });

    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("paid"); // unchanged — captured is terminal
  });

  // 9. GET status (page-refresh path) reflects the corrected final state
  // — no stale "unresolved" attempt, no lost agreement.
  it("GET status reflects paid with no resumable attempt after the failure -> success sequence, matching a page refresh", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await callWebhook(webhookPayload("payment.failed", order.razorpayOrderId, "pay_1", "GATEWAY_ERROR"), {
      eventId: "evt_p7_status_failed",
    });
    await callWebhook(webhookPayload("payment.captured", order.razorpayOrderId, "pay_2"), {
      eventId: "evt_p7_status_captured",
    });

    const { getPaymentStatus } = await import("@/lib/payment/paymentService");
    const status = await getPaymentStatus(agreementId);
    expect(status.agreementStatus).toBe("paid");
    expect(status.currentRazorpayOrderId).toBeNull(); // nothing left unresolved
    expect(status.attempts).toHaveLength(1);
    expect(status.attempts[0].status).toBe("success");
  });
});
