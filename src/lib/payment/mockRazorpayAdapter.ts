// Demo-safe deterministic PaymentProvider — PACT V2 Milestone 13.
//
// The exact counterpart to llm/gemini.ts alongside llm/claude.ts: same
// PaymentProvider interface as razorpayClient.ts's RealRazorpayProvider,
// zero shared implementation, selected the same way (an explicit
// environment variable — see getPaymentProvider in razorpayClient.ts,
// mirroring getLlmProvider's own selection discipline).
//
// What is and isn't mocked, precisely (Milestone 13 architecture review
// §P): ONLY the external Razorpay network call (createOrder) and the
// external Razorpay Checkout modal (which this adapter never opens — see
// NegotiationDemo.tsx's own mock-checkout branch) are faked. Every other
// piece of the real flow — paymentService.ts's orchestration,
// paymentRepository.ts's DB writes, the Agreement/PaymentAttempt state
// machine, AuditLog — runs completely unchanged, through the exact same
// code a real Razorpay payment would exercise. This is what makes the
// demo sequence a genuine exercise of the real recovery state machine,
// not a scripted UI animation.
//
// Deterministic by construction, never randomized (explicit project
// requirement): verifyCheckoutSignature accepts exactly one sentinel
// value and rejects everything else — there is no "sometimes valid"
// branch anywhere in this file. Which outcome (success/failure) a given
// checkout attempt should simulate is decided by paymentService.ts, from
// real server-side state (the PaymentAttempt's own attemptNumber/isRecovery)
// — never by this adapter, and never by the browser.

import type { CreateOrderInput, CreateOrderResult, PaymentProvider, VerifyCheckoutInput } from "@/lib/payment/razorpayClient";
import { generateMockOrderId } from "@/lib/payment/razorpayClient";
import { MOCK_VALID_SIGNATURE } from "@/types/payment";

// Re-exported for backward-compatible reference from server-side payment
// files (paymentService.ts) — the canonical definition lives in
// types/payment.ts, which is also safe for the browser to import (see
// that file's own comment on why).
export { MOCK_VALID_SIGNATURE };

export class MockRazorpayProvider implements PaymentProvider {
  async createOrder(_input: CreateOrderInput): Promise<CreateOrderResult> {
    void _input; // amount/currency/receipt are accepted for interface parity but never sent anywhere — no real order exists.
    return { providerOrderId: generateMockOrderId() };
  }

  verifyCheckoutSignature(input: VerifyCheckoutInput): boolean {
    // Deliberately ignores providerOrderId/providerPaymentId — this is not
    // real HMAC verification (there is nothing genuine to verify against;
    // no real Razorpay order or payment ever existed). The ONLY thing
    // that determines "valid" here is whether the caller supplied the
    // exact sentinel signature — a fixed, non-random, always-reproducible
    // check.
    return input.signature === MOCK_VALID_SIGNATURE;
  }
}

export const mockRazorpayProvider: PaymentProvider = new MockRazorpayProvider();
