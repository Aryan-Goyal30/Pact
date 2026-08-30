// Browser-safe payment DTOs — PACT V2 Milestone 13. Mirrors
// types/negotiation.ts's own "construct, don't spread" discipline: every
// shape here is an explicit whitelist, never a raw Prisma row forwarded
// to the client. RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET never
// appear in any type in this file.

import type { PaymentFailureReason } from "@/lib/payment/paymentFailure";

/**
 * The one signature value the mock payment provider ever accepts as
 * valid (see lib/payment/mockRazorpayAdapter.ts). Defined here, not
 * there, because this value is safe for and needed by BOTH sides: the
 * server-side mock provider (which checks for it) and the browser's
 * mock-checkout simulation (which must construct a request containing
 * it — see negotiate/paymentUi.ts). It is not a secret — its entire
 * purpose is to be a fixed, publicly-known, non-random sentinel; nothing
 * about mock-mode security depends on it being hidden. types/payment.ts
 * has no server-only imports (no prisma, no node:crypto), so it's safe
 * for a client component to import from here, unlike importing anything
 * from lib/payment/ directly.
 */
export const MOCK_VALID_SIGNATURE = "pact_mock_valid_signature";

/** Response for POST /api/agreements/:id/payment/order and .../recover — exactly what the browser needs to open Razorpay Checkout, nothing else. */
export interface PaymentOrderResponseDTO {
  razorpayOrderId: string;
  /** Paise (Razorpay's own subunit), never rupees — the browser passes this straight to Checkout unchanged. */
  amount: number;
  currency: string;
  /** Razorpay's PUBLIC key id — safe to expose (see razorpayClient.ts). Never the Key Secret. */
  keyId: string;
  attemptNumber: number;
  isRecovery: boolean;
  /** MAX_LOGICAL_PAYMENT_ATTEMPTS (paymentService.ts) — sent so the UI can render "Attempt N of M" without hardcoding its own copy of a server-owned constant. */
  maxAttempts: number;
  /**
   * Present ONLY when the mock provider is active (never in production —
   * see razorpayClient.ts's isMockProviderActive). Tells the browser's
   * mock-checkout branch which outcome to simulate, so the actual
   * success/failure decision stays server-side and deterministic rather
   * than something the browser invents — see mockRazorpayAdapter.ts's own
   * header comment.
   */
  mockForceOutcome?: "success" | "failure";
}

/** Response for POST /api/agreements/:id/payment/verify. */
export interface PaymentVerifyResponseDTO {
  attemptStatus: "success" | "failed";
  agreementStatus: string;
  failureReason?: PaymentFailureReason;
  /** Whether the user may now trigger POST .../payment/recover. */
  recoveryAvailable: boolean;
}

/** Response for POST /api/agreements/:id/payment/recover. */
export interface PaymentRecoverResponseDTO {
  order: PaymentOrderResponseDTO;
}

/** One PaymentAttempt's public-safe shape — no razorpayOrderId beyond what the UI needs to display, no internal ids the browser has no use for. */
export interface PaymentAttemptDTO {
  attemptNumber: number;
  isRecovery: boolean;
  status: "created" | "success" | "failed";
  failureReason?: PaymentFailureReason;
}

/** Response for GET /api/agreements/:id/payment. */
export interface PaymentStatusResponseDTO {
  agreementStatus: string;
  attempts: PaymentAttemptDTO[];
  recoveryAvailable: boolean;
  maxAttempts: number;
  /** The order id of the currently-unresolved attempt, if any — safe to expose (an order id alone authorizes nothing without the Key Secret). Lets the UI resume an in-progress checkout after a page refresh without creating a new order. */
  currentRazorpayOrderId: string | null;
}
