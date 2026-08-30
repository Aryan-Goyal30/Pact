import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createNegotiationSession } from "@/lib/negotiation/negotiationSessionRepository";
import { ensureAgreementForSession } from "@/lib/negotiation/agreementRepository";
import { getLlmProvider } from "@/lib/llm/provider";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
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

async function callOrder(id: string, body?: unknown): Promise<{ status: number; body: PaymentOrderResponseDTO & { error?: string } }> {
  const response = await POST(
    new Request("http://localhost/api/agreements/x/payment/order", {
      method: "POST",
      ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, body: (await response.json()) as PaymentOrderResponseDTO & { error?: string } };
}

describe("POST /api/agreements/:id/payment/order", () => {
  it("404s for an unknown Agreement id", async () => {
    const { status } = await callOrder("not-a-real-id");
    expect(status).toBe(404);
  });

  it("200s with a safe order response for a real, pending_payment Agreement", async () => {
    const agreementId = await createTestAgreement();
    const { status, body } = await callOrder(agreementId);

    expect(status).toBe(200);
    expect(body.razorpayOrderId).toMatch(/^order_mock_/);
    expect(body.currency).toBe("INR");
    expect(body.amount).toBe(4471900 * 100);
    expect((body as unknown as Record<string, unknown>).keySecret).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/secret/i);
  });

  // A request body that tries to override the amount is completely
  // ignored — the route never even reads the request body at all (see
  // route.ts's own comment), so there is no code path by which this
  // could matter.
  it("ignores any client-submitted amount in the request body — the server-derived amount always wins", async () => {
    const agreementId = await createTestAgreement();
    const { body } = await callOrder(agreementId, { amount: 1 });
    expect(body.amount).toBe(4471900 * 100);
  });

  it("duplicate order requests are idempotent — same order id, exactly one PaymentAttempt row", async () => {
    const agreementId = await createTestAgreement();
    const first = await callOrder(agreementId);
    const second = await callOrder(agreementId);

    expect(second.body.razorpayOrderId).toBe(first.body.razorpayOrderId);
    expect(await prisma.paymentAttempt.count({ where: { agreementId } })).toBe(1);
  });

  it("concurrent order requests never create more than one PaymentAttempt row", async () => {
    const agreementId = await createTestAgreement();
    // 2 concurrent callers — see paymentRepository.test.ts's own comment
    // on why the realistic double-click shape is what this proves.
    await Promise.all(Array.from({ length: 2 }, () => callOrder(agreementId)));
    expect(await prisma.paymentAttempt.count({ where: { agreementId } })).toBe(1);
  });

  it("409s when the Agreement is not eligible for a fresh order (already paid)", async () => {
    const agreementId = await createTestAgreement();
    const { body: order } = await callOrder(agreementId);
    // Resolve it directly via the service layer's own real path.
    const { verifyCheckoutPayment } = await import("@/lib/payment/paymentService");
    const { MOCK_VALID_SIGNATURE } = await import("@/types/payment");
    await verifyCheckoutPayment(agreementId, {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: "pay_1",
      razorpaySignature: MOCK_VALID_SIGNATURE,
    });

    const { status } = await callOrder(agreementId);
    expect(status).toBe(409);
  });
});
