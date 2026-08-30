// Bounded payment recovery — PACT V2 Milestone 13.
//
// User-triggered only — nothing in this codebase calls startRecovery
// automatically (no polling loop, no background job; see this file's own
// eligibility check, which only ever runs in reaction to a real
// POST .../payment/recover request). Never reopens negotiation, never
// touches quantity/pricePerUnit/deliveryDays, never creates a second
// Agreement — recovery always operates on the SAME Agreement a failed
// payment already belongs to (Milestone 13 architecture review §11: the
// repository gave no reason to prefer the alternative — reopening
// negotiation — over preserving the Agreement, so this file doesn't).

import {
  createPaymentAttempt,
  findUnresolvedAttempt,
  listPaymentAttempts,
  loadAgreementForPayment,
} from "@/lib/payment/paymentRepository";
import { createRazorpayOrder, MAX_LOGICAL_PAYMENT_ATTEMPTS } from "@/lib/payment/paymentService";
import { isMockProviderActive, rupeesToPaise } from "@/lib/payment/razorpayClient";
import { AgreementNotFoundError, AgreementNotEligibleError } from "@/lib/payment/paymentService";
import type { PaymentOrderResponseDTO } from "@/types/payment";
import type { AgreementForPayment, PaymentAttemptRow } from "@/lib/payment/paymentRepository";

/** Thrown when recovery is requested but the Agreement has already used its one bounded recovery attempt (or somehow has more attempts on record than the bound allows). */
export class RecoveryLimitExceededError extends Error {
  constructor() {
    super(`Recovery is not available: the maximum of ${MAX_LOGICAL_PAYMENT_ATTEMPTS} logical payment attempts has already been used.`);
    this.name = "RecoveryLimitExceededError";
  }
}

/**
 * Starts the single bounded recovery attempt for a failed Agreement.
 * Preconditions, all enforced here (never assumed by the caller):
 *
 *  - Agreement must exist and currently be "failed" — recovering an
 *    Agreement that's "pending_payment" (nothing has failed yet),
 *    "paid"/"recovered" (already succeeded — recovery is meaningless),
 *    or "closed" (terminal) is rejected outright.
 *  - At most MAX_LOGICAL_PAYMENT_ATTEMPTS (2) total PaymentAttempt rows
 *    may ever exist for one Agreement — a second recover() call (a
 *    double-click, or a genuinely repeated request after this one
 *    already ran) is rejected with RecoveryLimitExceededError, not
 *    silently allowed to create a third attempt.
 *
 * Razorpay order reuse (Milestone 13 §22, grounded in the current
 * official Razorpay documentation supplied for this milestone: a failed
 * payment may be retried against the SAME order_id; a new order is only
 * required when the payment/fulfilment details themselves change):
 * since Agreement terms are immutable once created (nothing in this
 * codebase ever updates quantity/pricePerUnit/totalAmount after
 * ensureAgreementForSession creates them), the payment details recovery
 * would need a new order for can never actually change here — so
 * recovery ALWAYS reuses attempt #1's own razorpayOrderId when one
 * exists. A new Razorpay order is only ever created in the one case
 * where attempt #1 never durably obtained one in the first place (its
 * own order-creation call itself failed) — genuinely nothing to reuse.
 *
 * M13.1 — RESUME, not just CREATE (the real-provider hardening this
 * function needed): if a recovery attempt already exists and is still
 * unresolved (`status: "created"` — e.g. the browser crashed or the
 * Checkout modal never completed its round trip after an earlier
 * `/recover` call), this call idempotently RESUMES that exact same
 * attempt — same PaymentAttempt row, same razorpayOrderId, same
 * attemptNumber — rather than trying to create a new one. This is what
 * makes an interrupted recovery resumable instead of a dead end: by
 * construction, the moment `Agreement.status === "failed"` is true,
 * attempt #1 is guaranteed already terminal (resolvePaymentAttempt only
 * ever sets that status once attempt #1 has resolved to "failed" — see
 * paymentRepository.ts), so ANY unresolved row found at this point can
 * only be an already-started recovery attempt — never attempt #1 itself,
 * and never a reason to create a 3rd attempt.
 */
export async function startRecovery(agreementId: string): Promise<PaymentOrderResponseDTO> {
  const agreement = await loadAgreementForPayment(agreementId);
  if (!agreement) {
    throw new AgreementNotFoundError(agreementId);
  }
  if (agreement.status !== "failed") {
    throw new AgreementNotEligibleError(
      agreement.status,
      `Cannot start recovery: Agreement status is "${agreement.status}", not "failed".`,
    );
  }

  const alreadyOpenRecovery = await findUnresolvedAttempt(agreementId);
  if (alreadyOpenRecovery) {
    return toRecoveryOrderResponse(agreement, alreadyOpenRecovery);
  }

  const attempts = await listPaymentAttempts(agreementId);
  if (attempts.length >= MAX_LOGICAL_PAYMENT_ATTEMPTS) {
    throw new RecoveryLimitExceededError();
  }

  const priorAttempt = attempts.find((a) => a.attemptNumber === 1);
  const razorpayOrderId = priorAttempt?.razorpayOrderId
    ? priorAttempt.razorpayOrderId // reuse — see this function's own doc comment
    : await createRazorpayOrder(agreement, rupeesToPaise(agreement.totalAmount)); // genuinely nothing to reuse

  const nextAttemptNumber = (priorAttempt?.attemptNumber ?? 0) + 1;
  const { attempt } = await createPaymentAttempt({
    agreementId,
    attemptNumber: nextAttemptNumber,
    isRecovery: true,
    razorpayOrderId,
  });

  return toRecoveryOrderResponse(agreement, attempt);
}

/** The safe browser-facing shape for a recovery attempt — shared by both the "create" and "resume" paths above, so they can never drift apart. */
function toRecoveryOrderResponse(agreement: AgreementForPayment, attempt: PaymentAttemptRow): PaymentOrderResponseDTO {
  return {
    razorpayOrderId: attempt.razorpayOrderId as string,
    amount: rupeesToPaise(agreement.totalAmount),
    currency: "INR",
    keyId: process.env.RAZORPAY_KEY_ID ?? "",
    attemptNumber: attempt.attemptNumber,
    isRecovery: attempt.isRecovery,
    maxAttempts: MAX_LOGICAL_PAYMENT_ATTEMPTS,
    // Demo sequence (Milestone 13 §16): a recovery attempt always
    // simulates success — deterministic, never randomized — whether this
    // is the moment it was first created or a later resume of the same
    // still-open attempt.
    ...(isMockProviderActive() ? { mockForceOutcome: "success" as const } : {}),
  };
}
