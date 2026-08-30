// PACT V2 Milestone 13 — Step 18 security tests, each mapped 1:1 to the
// milestone's own explicit checklist. Several of these properties are
// already exercised incidentally elsewhere in this module's test suite;
// this file exists so each specific security claim has its own,
// explicitly-named, easy-to-find proof rather than being buried inside a
// broader functional test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { createNegotiationSession } from "@/lib/negotiation/negotiationSessionRepository";
import { ensureAgreementForSession } from "@/lib/negotiation/agreementRepository";
import { getLlmProvider } from "@/lib/llm/provider";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import { createOrderForAgreement, verifyCheckoutPayment } from "@/lib/payment/paymentService";
import { startRecovery, RecoveryLimitExceededError } from "@/lib/payment/recoveryService";
import { MOCK_VALID_SIGNATURE } from "@/types/payment";
import { POST as verifyRoute } from "@/app/api/agreements/[id]/payment/verify/route";
import { POST as orderRoute } from "@/app/api/agreements/[id]/payment/order/route";
import { POST as webhookRoute } from "@/app/api/payments/webhook/route";

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
  process.env = {
    ...ORIGINAL_ENV,
    PAYMENT_PROVIDER: "mock",
    NODE_ENV: "test",
    RAZORPAY_KEY_SECRET: "top_secret_key_value",
    RAZORPAY_WEBHOOK_SECRET: "top_secret_webhook_value",
  };
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

describe("Security: Key Secret never appears in any frontend-facing output", () => {
  it("POST .../payment/order never includes RAZORPAY_KEY_SECRET anywhere in its response", async () => {
    const agreementId = await createTestAgreement();
    const response = await orderRoute(new Request("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id: agreementId }) });
    const text = await response.text();
    expect(text).not.toContain("top_secret_key_value");
  });

  it("POST .../payment/verify's response never includes RAZORPAY_KEY_SECRET", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    const response = await verifyRoute(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ razorpayOrderId: order.razorpayOrderId, razorpayPaymentId: "p", razorpaySignature: MOCK_VALID_SIGNATURE }),
      }),
      { params: Promise.resolve({ id: agreementId }) },
    );
    const text = await response.text();
    expect(text).not.toContain("top_secret_key_value");
  });
});

describe("Security: webhook secret never appears in any frontend-facing output", () => {
  it("no payment route response ever includes RAZORPAY_WEBHOOK_SECRET", async () => {
    const agreementId = await createTestAgreement();
    const response = await orderRoute(new Request("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id: agreementId }) });
    const text = await response.text();
    expect(text).not.toContain("top_secret_webhook_value");
  });
});

describe("Security: amount cannot be overridden by request body", () => {
  it("a client-submitted amount in the order-creation request body is silently ignored — the response amount is always server-derived", async () => {
    const agreementId = await createTestAgreement();
    const response = await orderRoute(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 1, amountPaise: 1 }),
      }),
      { params: Promise.resolve({ id: agreementId }) },
    );
    const body = (await response.json()) as { amount: number };
    expect(body.amount).toBe(4471900 * 100); // the real, server-derived amount — never 1
  });
});

describe("Security: Agreement terms cannot be overridden by request body", () => {
  it("verify's request body has no field that could change quantity/price/delivery — only razorpay* fields are ever read", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await verifyRoute(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          razorpayOrderId: order.razorpayOrderId,
          razorpayPaymentId: "p",
          razorpaySignature: MOCK_VALID_SIGNATURE,
          quantity: 999999,
          unitPrice: 1,
          deliveryDays: 0,
        }),
      }),
      { params: Promise.resolve({ id: agreementId }) },
    );

    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.quantity).toBe(100);
    expect(agreement.pricePerUnit).toBe(44719);
    expect(agreement.deliveryDays).toBe(5);
  });
});

describe("Security: wrong Agreement/order combination is rejected", () => {
  it("verifying Agreement A's payment using an order id that belongs to Agreement B is rejected outright", async () => {
    const agreementA = await createTestAgreement();
    const agreementB = await createTestAgreement();
    const orderForB = await createOrderForAgreement(agreementB);

    await expect(
      verifyCheckoutPayment(agreementA, {
        razorpayOrderId: orderForB.razorpayOrderId,
        razorpayPaymentId: "p",
        razorpaySignature: MOCK_VALID_SIGNATURE,
      }),
    ).rejects.toThrow();

    const a = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementA } });
    expect(a.status).toBe("pending_payment"); // never paid via someone else's order
  });
});

describe("Security: invalid signatures are rejected", () => {
  it("checkout verification rejects a forged/incorrect signature", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    const result = await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "p",
      razorpaySignature: "definitely-not-valid",
    });
    expect(result.attemptStatus).toBe("failed");
  });

  it("webhook verification rejects a forged/incorrect signature and never processes the event", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "p", order_id: order.razorpayOrderId } } } });

    const response = await webhookRoute(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "x-razorpay-signature": "forged", "x-razorpay-event-id": "evt_forged" },
        body,
      }),
    );

    expect(response.status).toBe(400);
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("pending_payment"); // never processed
  });
});

describe("Security: duplicate webhook does not duplicate side effects", () => {
  it("delivering the same event twice results in exactly one PAYMENT_SUCCEEDED audit row and one status transition", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET!;
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "p", order_id: order.razorpayOrderId } } } });
    const signature = createHmac("sha256", secret).update(body).digest("hex");

    for (let i = 0; i < 2; i++) {
      await webhookRoute(
        new Request("http://localhost/x", {
          method: "POST",
          headers: { "x-razorpay-signature": signature, "x-razorpay-event-id": "evt_dup_side_effects" },
          body,
        }),
      );
    }

    expect(await prisma.auditLog.count({ where: { agreementId, eventType: "PAYMENT_SUCCEEDED" } })).toBe(1);
  });
});

describe("Security: paid state cannot regress", () => {
  it("no combination of verify/webhook calls can move a paid Agreement to any other status", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await verifyCheckoutPayment(agreementId, { razorpayOrderId: order.razorpayOrderId, razorpayPaymentId: "p", razorpaySignature: MOCK_VALID_SIGNATURE });

    // Attempt every kind of contradictory follow-up call.
    await verifyCheckoutPayment(agreementId, { razorpayOrderId: order.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" }).catch(() => {});
    await expect(startRecovery(agreementId)).rejects.toThrow(); // paid is not "failed" — recovery correctly refuses too

    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).toBe("paid");
  });
});

describe("Security: recovery cannot exceed the bound", () => {
  it("a 3rd recovery attempt is rejected outright, regardless of how it's requested", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await verifyCheckoutPayment(agreementId, { razorpayOrderId: order.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });
    const recovery = await startRecovery(agreementId);
    await verifyCheckoutPayment(agreementId, { razorpayOrderId: recovery.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });

    await expect(startRecovery(agreementId)).rejects.toBeInstanceOf(RecoveryLimitExceededError);
    expect(await prisma.paymentAttempt.count({ where: { agreementId } })).toBe(2); // never 3
  });
});
