// Pure helper functions for the payment panel — PACT V2 Milestone 13.
// Mirrors negotiationUi.ts's own discipline exactly: the non-trivial
// logic lives here, unit-testable without a browser/DOM environment;
// PaymentPanel.tsx stays thin and presentational. Deliberately imports
// nothing from src/lib/payment/ (which touches prisma, node:crypto, and
// the razorpay SDK — none of that may ever reach a client bundle) — only
// from types/payment.ts, which is safe for both sides (see that file's
// own comment on MOCK_VALID_SIGNATURE).

import { MOCK_VALID_SIGNATURE, type PaymentOrderResponseDTO } from "@/types/payment";

export interface VerifyRequestBody {
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  reportedFailureCode?: string;
}

/**
 * Builds the /verify request body for a REAL Razorpay Checkout success —
 * i.e. what the `handler(response)` callback receives, forwarded as-is.
 * Checkout's own `payment.failed` event has no equivalent "success"
 * shape to relay; a real failure is reported via
 * buildReportedFailureRequestBody instead.
 */
export function buildCheckoutSuccessRequestBody(response: {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}): VerifyRequestBody {
  return {
    razorpayOrderId: response.razorpay_order_id,
    razorpayPaymentId: response.razorpay_payment_id,
    razorpaySignature: response.razorpay_signature,
  };
}

/** Builds the /verify request body for a REAL Checkout-reported failure (the `payment.failed` event) — no signature exists to relay; see paymentFailure.ts's own reasoning on why a failure claim needs none. */
export function buildReportedFailureRequestBody(razorpayOrderId: string, errorCode: string | undefined): VerifyRequestBody {
  return { razorpayOrderId, reportedFailureCode: errorCode };
}

/**
 * Builds the /verify request body for the MOCK checkout simulation —
 * never opens real Checkout.js at all (see PaymentPanel.tsx). The
 * outcome to simulate is decided entirely server-side
 * (order.mockForceOutcome, set by paymentService.ts from real
 * PaymentAttempt state — see mockRazorpayAdapter.ts's own header
 * comment) — this function only relays that already-decided hint into
 * the shape /verify expects; it never itself decides success or failure.
 */
export function buildMockVerifyRequestBody(order: PaymentOrderResponseDTO): VerifyRequestBody {
  if (order.mockForceOutcome === "success") {
    return {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: `pay_mock_${order.razorpayOrderId}`,
      razorpaySignature: MOCK_VALID_SIGNATURE,
    };
  }
  // Default to a failure report whenever the hint isn't explicitly
  // "success" (covers "failure" and, defensively, an absent hint) — the
  // mock provider should never be reachable without a hint in practice
  // (isMockProviderActive gates it), but this keeps the function total.
  return { razorpayOrderId: order.razorpayOrderId, reportedFailureCode: "GATEWAY_ERROR" };
}

export function attemptProgressLabel(attemptNumber: number, isRecovery: boolean, maxAttempts: number): string {
  return isRecovery
    ? `Attempt ${attemptNumber} of ${maxAttempts} (Recovery)`
    : `Attempt ${attemptNumber} of ${maxAttempts}`;
}

const AGREEMENT_PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending_payment: "Payment pending",
  paid: "Payment successful",
  failed: "Payment failed",
  recovered: "Payment recovered",
  closed: "Closed",
};

export function paymentStatusLabel(agreementStatus: string): string {
  return AGREEMENT_PAYMENT_STATUS_LABELS[agreementStatus] ?? agreementStatus;
}

const PAYMENT_FAILURE_LABELS: Record<string, string> = {
  payment_declined: "The payment was declined.",
  verification_failed: "The payment could not be verified.",
  order_creation_failed: "Could not start the payment — please try again.",
  timeout: "The payment did not complete in time.",
  unknown: "The payment could not be completed.",
};

/** UI-safe failure copy — mirrors lib/payment/paymentFailure.ts's own describePaymentFailure exactly, duplicated here (not imported) purely for the client/server module boundary (see this file's own header comment); both must be updated together if the taxonomy ever changes. */
export function paymentFailureLabel(reason: string | undefined): string {
  if (!reason) return "";
  return PAYMENT_FAILURE_LABELS[reason] ?? "The payment could not be completed.";
}
