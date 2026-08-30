import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createNegotiationSession } from "@/lib/negotiation/negotiationSessionRepository";
import { ensureAgreementForSession } from "@/lib/negotiation/agreementRepository";
import { getLlmProvider } from "@/lib/llm/provider";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import { createOrderForAgreement } from "@/lib/payment/paymentService";
import { MOCK_VALID_SIGNATURE } from "@/types/payment";
import { POST } from "./route";
import type { PaymentVerifyResponseDTO } from "@/types/payment";

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

async function callVerify(id: string, body: unknown): Promise<{ status: number; body: PaymentVerifyResponseDTO & { error?: string } }> {
  const response = await POST(
    new Request("http://localhost/api/agreements/x/payment/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, body: (await response.json()) as PaymentVerifyResponseDTO & { error?: string } };
}

describe("POST /api/agreements/:id/payment/verify", () => {
  it("400s when razorpayOrderId is missing", async () => {
    const agreementId = await createTestAgreement();
    const { status } = await callVerify(agreementId, {});
    expect(status).toBe(400);
  });

  it("400s on invalid JSON", async () => {
    const agreementId = await createTestAgreement();
    const response = await POST(
      new Request("http://localhost/x", { method: "POST", body: "{not json" }),
      { params: Promise.resolve({ id: agreementId }) },
    );
    expect(response.status).toBe(400);
  });

  it("404s for an unknown Agreement id", async () => {
    const { status } = await callVerify("not-a-real-id", { razorpayOrderId: "order_x" });
    expect(status).toBe(404);
  });

  it("200s and marks the Agreement paid on a genuinely valid signature", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    const { status, body } = await callVerify(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "pay_1",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });

    expect(status).toBe(200);
    expect(body.attemptStatus).toBe("success");
    expect(body.agreementStatus).toBe("paid");
  });

  it("rejects an invalid signature — never marks paid", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    const { body } = await callVerify(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "pay_1",
      razorpaySignature: "forged",
    });

    expect(body.attemptStatus).toBe("failed");
    expect(body.failureReason).toBe("verification_failed");
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.status).not.toBe("paid");
  });

  it("400s on a wrong order/agreement combination (an order id this Agreement doesn't own)", async () => {
    const agreementId = await createTestAgreement();
    await createOrderForAgreement(agreementId);
    const { status } = await callVerify(agreementId, {
      razorpayOrderId: "order_mock_belongs_to_nobody",
      razorpayPaymentId: "pay_1",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });
    expect(status).toBe(400);
  });

  it("a duplicate verification of an already-resolved attempt does not re-apply or double-write", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    const input = { razorpayOrderId: order.razorpayOrderId, razorpayPaymentId: "pay_1", razorpaySignature: MOCK_VALID_SIGNATURE };

    const first = await callVerify(agreementId, input);
    const second = await callVerify(agreementId, input);

    expect(first.status).toBe(200);
    expect(second.status).toBe(400); // no unresolved attempt left to verify — rejected, never silently re-applied
    expect(await prisma.auditLog.count({ where: { agreementId, eventType: "PAYMENT_SUCCEEDED" } })).toBe(1);
  });
});
