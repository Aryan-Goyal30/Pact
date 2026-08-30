import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

async function callReportFailure(id: string, body: unknown): Promise<{ status: number; body: { recorded?: boolean; error?: string } }> {
  const response = await POST(
    new Request("http://localhost/api/agreements/x/payment/report-failure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, body: (await response.json()) as { recorded?: boolean; error?: string } };
}

describe("POST /api/agreements/:id/payment/report-failure", () => {
  it("404s for an unknown Agreement id", async () => {
    const { status } = await callReportFailure("not-a-real-id", { razorpayOrderId: "order_x" });
    expect(status).toBe(404);
  });

  it("400s when razorpayOrderId is missing", async () => {
    const agreementId = await createTestAgreement();
    const { status } = await callReportFailure(agreementId, {});
    expect(status).toBe(400);
  });

  it("400s on invalid JSON", async () => {
    const agreementId = await createTestAgreement();
    const response = await POST(new Request("http://localhost/x", { method: "POST", body: "not json" }), {
      params: Promise.resolve({ id: agreementId }),
    });
    expect(response.status).toBe(400);
  });

  it("200s and records the event WITHOUT changing the attempt/Agreement status — the core M13.2 fix, proven at the HTTP layer", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    const { status, body } = await callReportFailure(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      errorCode: "BAD_OTP",
      errorDescription: "OTP incorrect",
      reportedPaymentId: "pay_declined",
    });

    expect(status).toBe(200);
    expect(body.recorded).toBe(true);

    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { agreementId } });
    const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(attempt.status).toBe("created");
    expect(agreement.status).toBe("pending_payment");

    const logs = await prisma.auditLog.findMany({ where: { agreementId, eventType: "PAYMENT_FAILURE_REPORTED" } });
    expect(logs).toHaveLength(1);
  });

  it("a later real success (via /verify) still resolves to paid after one or more reported failures — proven at the HTTP layer", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    await callReportFailure(agreementId, { razorpayOrderId: order.razorpayOrderId, errorCode: "BAD_OTP" });
    await callReportFailure(agreementId, { razorpayOrderId: order.razorpayOrderId, errorCode: "CARD_DECLINED" });

    const result = await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "pay_success",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });

    expect(result.agreementStatus).toBe("paid");
    expect(await prisma.paymentAttempt.count({ where: { agreementId } })).toBe(1); // never a 2nd attempt
  });

  it("never requires a signature — no razorpayPaymentId/razorpaySignature field exists on this endpoint's contract at all", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    const { status } = await callReportFailure(agreementId, { razorpayOrderId: order.razorpayOrderId });
    expect(status).toBe(200);
  });
});
