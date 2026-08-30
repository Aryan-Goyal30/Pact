import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createNegotiationSession } from "@/lib/negotiation/negotiationSessionRepository";
import { ensureAgreementForSession } from "@/lib/negotiation/agreementRepository";
import { getLlmProvider } from "@/lib/llm/provider";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import { createOrderForAgreement, verifyCheckoutPayment } from "@/lib/payment/paymentService";
import { POST } from "./route";
import type { PaymentOrderResponseDTO } from "@/types/payment";

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

async function failFirstAttempt(agreementId: string): Promise<void> {
  const order = await createOrderForAgreement(agreementId);
  await verifyCheckoutPayment(agreementId, { razorpayOrderId: order.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });
}

async function callRecover(id: string): Promise<{ status: number; body: PaymentOrderResponseDTO & { error?: string } }> {
  const response = await POST(
    new Request("http://localhost/api/agreements/x/payment/recover", { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, body: (await response.json()) as PaymentOrderResponseDTO & { error?: string } };
}

describe("POST /api/agreements/:id/payment/recover", () => {
  it("404s for an unknown Agreement id", async () => {
    const { status } = await callRecover("not-a-real-id");
    expect(status).toBe(404);
  });

  it("409s when the Agreement hasn't failed yet", async () => {
    const agreementId = await createTestAgreement();
    const { status } = await callRecover(agreementId);
    expect(status).toBe(409);
  });

  it("200s and starts a real, bounded recovery attempt for a genuinely failed Agreement", async () => {
    const agreementId = await createTestAgreement();
    await failFirstAttempt(agreementId);

    const { status, body } = await callRecover(agreementId);

    expect(status).toBe(200);
    expect(body.attemptNumber).toBe(2);
    expect(body.isRecovery).toBe(true);
  });

  it("409s once the recovery bound is already used", async () => {
    const agreementId = await createTestAgreement();
    await failFirstAttempt(agreementId);
    const recovery = await callRecover(agreementId);
    await verifyCheckoutPayment(agreementId, { razorpayOrderId: recovery.body.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });

    const { status } = await callRecover(agreementId);
    expect(status).toBe(409);
  });

  // M13.1 — the real-provider fix, proven through the actual HTTP route:
  // a second /recover call while attempt #2 is still unresolved (never
  // 409s, never creates a 3rd attempt) — resumes the same one instead.
  it("M13.1: a repeated /recover call while attempt #2 is still unresolved resumes it (200, same order/attempt) rather than 409ing or creating attempt #3", async () => {
    const agreementId = await createTestAgreement();
    await failFirstAttempt(agreementId);

    const first = await callRecover(agreementId);
    const second = await callRecover(agreementId);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.attemptNumber).toBe(2);
    expect(second.body.razorpayOrderId).toBe(first.body.razorpayOrderId);
  });
});
