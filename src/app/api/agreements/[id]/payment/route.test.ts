import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createNegotiationSession } from "@/lib/negotiation/negotiationSessionRepository";
import { ensureAgreementForSession } from "@/lib/negotiation/agreementRepository";
import { getLlmProvider } from "@/lib/llm/provider";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import { createOrderForAgreement, reportCheckoutFailure, verifyCheckoutPayment } from "@/lib/payment/paymentService";
import { startRecovery } from "@/lib/payment/recoveryService";
import { GET } from "./route";
import type { PaymentStatusResponseDTO } from "@/types/payment";

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

async function callStatus(id: string): Promise<{ status: number; body: PaymentStatusResponseDTO & { error?: string } }> {
  const response = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id }) });
  return { status: response.status, body: (await response.json()) as PaymentStatusResponseDTO & { error?: string } };
}

describe("GET /api/agreements/:id/payment", () => {
  it("404s for an unknown Agreement id", async () => {
    const { status } = await callStatus("not-a-real-id");
    expect(status).toBe(404);
  });

  it("200s with pending_payment and no attempts before any order exists", async () => {
    const agreementId = await createTestAgreement();
    const { status, body } = await callStatus(agreementId);
    expect(status).toBe(200);
    expect(body.agreementStatus).toBe("pending_payment");
    expect(body.attempts).toEqual([]);
  });

  it("reflects the currently-unresolved order id after Pay Now, for resuming a checkout after a page refresh", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);

    const { body } = await callStatus(agreementId);
    expect(body.currentRazorpayOrderId).toBe(order.razorpayOrderId);
  });

  // M13.1 — the exact real-provider regression, proven through the real
  // HTTP GET route: Attempt #1 failed, Attempt #2 created (unresolved)
  // must report as resumable, not "exhausted after 2 attempts."
  it("M13.1: Attempt #1 failed + Attempt #2 created (unresolved) → recoveryAvailable = true", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await verifyCheckoutPayment(agreementId, { razorpayOrderId: order.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" });
    await startRecovery(agreementId); // attempt #2, deliberately left unresolved

    const { status, body } = await callStatus(agreementId);

    expect(status).toBe(200);
    expect(body.agreementStatus).toBe("failed");
    expect(body.attempts).toHaveLength(2);
    expect(body.attempts[1]).toMatchObject({ attemptNumber: 2, isRecovery: true, status: "created" });
    expect(body.recoveryAvailable).toBe(true);
    expect(body.currentRazorpayOrderId).toBe(order.razorpayOrderId);
  });

  // M13.2 — item L: one or more reported (informational-only)
  // payment.failed events must NOT change what GET .../payment reports —
  // the attempt stays "created"/unresolved, the Agreement stays
  // "pending_payment", and the resumable order id is still surfaced.
  it("M13.2: reported payment.failed events leave the attempt unresolved and pending_payment — status still correctly resumable", async () => {
    const agreementId = await createTestAgreement();
    const order = await createOrderForAgreement(agreementId);
    await reportCheckoutFailure(agreementId, { razorpayOrderId: order.razorpayOrderId, errorCode: "BAD_OTP" });
    await reportCheckoutFailure(agreementId, { razorpayOrderId: order.razorpayOrderId, errorCode: "CARD_DECLINED" });

    const { status, body } = await callStatus(agreementId);

    expect(status).toBe(200);
    expect(body.agreementStatus).toBe("pending_payment"); // never invented into "failed"
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0]).toMatchObject({ attemptNumber: 1, status: "created" });
    expect(body.currentRazorpayOrderId).toBe(order.razorpayOrderId); // still resumable
  });
});
