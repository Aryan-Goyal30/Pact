// PACT V2 Milestone 13 — the payment failure taxonomy.
//
// Mirrors WalkAwayReason's own discipline (walkAway.ts): a small, closed,
// named vocabulary — never a raw provider error string surfaced directly
// to an Agreement-facing field. Razorpay's own error payloads (checkout
// failure events, webhook payloads) carry far more detail than this; that
// raw detail belongs in AuditLog.payload (see paymentRepository.ts), never
// in PaymentAttempt.failureReason, which stays a closed, queryable
// vocabulary a UI can safely render without risking a leaked internal
// message.
//
// Five values, deliberately not exhaustive of every Razorpay error code —
// see the Milestone 13 architecture review (§L) for why this is the
// smallest useful taxonomy rather than a giant provider-error enum.

export type PaymentFailureReason =
  | "payment_declined"
  | "verification_failed"
  | "order_creation_failed"
  | "timeout"
  | "unknown";

export const PAYMENT_FAILURE_REASONS: readonly PaymentFailureReason[] = [
  "payment_declined",
  "verification_failed",
  "order_creation_failed",
  "timeout",
  "unknown",
];

/** Human-readable, UI-safe copy for each failure reason — never a raw provider message. */
const FAILURE_REASON_LABELS: Record<PaymentFailureReason, string> = {
  payment_declined: "The payment was declined.",
  verification_failed: "The payment could not be verified.",
  order_creation_failed: "Could not start the payment — please try again.",
  timeout: "The payment did not complete in time.",
  unknown: "The payment could not be completed.",
};

export function describePaymentFailure(reason: PaymentFailureReason): string {
  return FAILURE_REASON_LABELS[reason];
}

/**
 * Classifies a client-reported checkout failure into the closed taxonomy.
 * `code` is Razorpay's own error.code from the `payment.failed` checkout
 * event (e.g. "BAD_REQUEST_ERROR", "GATEWAY_ERROR") — never trusted for
 * anything beyond this classification (see paymentService.ts: a reported
 * failure requires no cryptographic proof, since it grants nothing, unlike
 * a reported success).
 */
export function classifyCheckoutFailure(code: string | undefined | null): PaymentFailureReason {
  if (!code) return "unknown";
  const normalized = code.toUpperCase();
  if (normalized.includes("TIMEOUT")) return "timeout";
  if (normalized.includes("GATEWAY") || normalized.includes("BANK") || normalized.includes("CARD")) {
    return "payment_declined";
  }
  return "unknown";
}
