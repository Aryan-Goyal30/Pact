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
  /**
   * Only ever sent by the MOCK checkout simulation now (see
   * buildMockVerifyRequestBody) — a REAL Checkout `payment.failed` event
   * is reported via buildFailureReportRequestBody / .../report-failure
   * instead (M13.2), never through /verify, since it must never
   * terminalize anything.
   */
  reportedFailureCode?: string;
}

/** M13.2 — the request body for POST .../payment/report-failure: purely informational, no signature, no proof required (a decline report unlocks/forecloses nothing). */
export interface FailureReportRequestBody {
  razorpayOrderId: string;
  errorCode?: string;
  errorDescription?: string;
  reportedPaymentId?: string;
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

/**
 * Builds the /report-failure request body for a REAL Checkout-reported
 * failure (the `payment.failed` event) — M13.2. No signature exists to
 * relay, and unlike the old (pre-M13.2) /verify-based version of this
 * builder, this is now DELIBERATELY informational-only: Razorpay's
 * Checkout `retry` option defaults to enabled (PACT never disables it —
 * see PaymentPanel.tsx), so the modal may stay open after this exact
 * decline and later receive a genuine success against the SAME order —
 * this report must never be capable of terminalizing the PaymentAttempt
 * or consuming any part of the recovery budget. `errorCode`/
 * `errorDescription`/`paymentId` (Razorpay's own `error.metadata.payment_id`,
 * when present) are all recorded purely for the audit trail.
 */
export function buildFailureReportRequestBody(
  razorpayOrderId: string,
  errorCode: string | undefined,
  errorDescription: string | undefined,
  paymentId: string | undefined,
): FailureReportRequestBody {
  return {
    razorpayOrderId,
    ...(errorCode ? { errorCode } : {}),
    ...(errorDescription ? { errorDescription } : {}),
    ...(paymentId ? { reportedPaymentId: paymentId } : {}),
  };
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

/** Same convention as every other formatInr in the app (negotiationUi.ts, dashboardUi.ts, buyerConversationUi.ts) — a small local copy, not a cross-import, matching this codebase's own established pattern for this trivial pure formatter. */
export function formatInr(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
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
