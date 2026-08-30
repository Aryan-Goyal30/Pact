import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { createNegotiationSession } from "@/lib/negotiation/negotiationSessionRepository";
import { ensureAgreementForSession } from "@/lib/negotiation/agreementRepository";
import { getLlmProvider } from "@/lib/llm/provider";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import { createOrderForAgreement } from "@/lib/payment/paymentService";
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

  it("a valid payment.failed event resolves the matching attempt to failed, classified via the closed taxonomy", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    const body = webhookPayload("payment.failed", order.razorpayOrderId, "pay_1", "GATEWAY_ERROR");

    await callWebhook(body, { eventId: "evt_failed_1" });

    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { agreementId } });
    expect(attempt.status).toBe("failed");
    expect(attempt.failureReason).toBe("payment_declined");
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
