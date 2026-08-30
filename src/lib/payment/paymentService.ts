// Payment orchestration — PACT V2 Milestone 13.
//
// Never imports the `razorpay` SDK directly (only razorpayClient.ts does
// — see that file's own header comment) and never imports any negotiation
// file (negotiationEngine.ts, negotiationState.ts, buyer/merchant
// agents/rules, leverage.ts, walkAway.ts, candidate generation/ranking,
// messageIntegrity.ts) — payment begins strictly from an already-existing
// Agreement and never reaches back into how that Agreement was decided.
//
// Every function here answers "is the payment for this already-agreed
// deal complete" — never "what was agreed," which stays exclusively
// negotiation's question (Milestone 13 architecture review §T).

import {
  createPaymentAttempt,
  findUnresolvedAttempt,
  listPaymentAttempts,
  loadAgreementForPayment,
  recordOrderCreationFailure,
  recordVerificationStarted,
  resolvePaymentAttempt,
  type AgreementForPayment,
  type PaymentAttemptRow,
} from "@/lib/payment/paymentRepository";
import { getPaymentProvider, isMockProviderActive, rupeesToPaise } from "@/lib/payment/razorpayClient";
import { MOCK_VALID_SIGNATURE } from "@/lib/payment/mockRazorpayAdapter";
import { classifyCheckoutFailure, type PaymentFailureReason } from "@/lib/payment/paymentFailure";
import type {
  PaymentAttemptDTO,
  PaymentOrderResponseDTO,
  PaymentStatusResponseDTO,
  PaymentVerifyResponseDTO,
} from "@/types/payment";

export const MAX_LOGICAL_PAYMENT_ATTEMPTS = 2;

export class AgreementNotFoundError extends Error {
  constructor(agreementId: string) {
    super(`No Agreement found for id "${agreementId}".`);
    this.name = "AgreementNotFoundError";
  }
}

/** Thrown when an operation is requested against an Agreement whose current status doesn't permit it — e.g. creating an order for an Agreement that's already "paid". Carries the Agreement's actual current status so the route can report it. */
export class AgreementNotEligibleError extends Error {
  constructor(
    public readonly currentStatus: string,
    message: string,
  ) {
    super(message);
    this.name = "AgreementNotEligibleError";
  }
}

export class OrderCreationFailedError extends Error {
  readonly reason: PaymentFailureReason = "order_creation_failed";
  constructor(cause: unknown) {
    super("Could not create the Razorpay order.");
    this.name = "OrderCreationFailedError";
    this.cause = cause;
  }
}

/** The submitted razorpay_order_id doesn't match the Agreement's own currently-unresolved attempt (or none exists) — never trust the browser's own claimed order/agreement relationship (Milestone 13 §7). */
export class VerificationMismatchError extends Error {
  constructor() {
    super("No matching unresolved payment attempt found for this Agreement and order.");
    this.name = "VerificationMismatchError";
  }
}

function toOrderResponse(
  attempt: PaymentAttemptRow,
  amountPaise: number,
  mockForceOutcome?: "success" | "failure",
): PaymentOrderResponseDTO {
  return {
    razorpayOrderId: attempt.razorpayOrderId as string,
    amount: amountPaise,
    currency: "INR",
    keyId: process.env.RAZORPAY_KEY_ID ?? "",
    attemptNumber: attempt.attemptNumber,
    isRecovery: attempt.isRecovery,
    maxAttempts: MAX_LOGICAL_PAYMENT_ATTEMPTS,
    ...(mockForceOutcome ? { mockForceOutcome } : {}),
  };
}

/**
 * Creates (or idempotently returns) the Razorpay order for an Agreement's
 * FIRST payment attempt. Rules, in order:
 *
 *  1. Agreement must exist and be "pending_payment" — UNLESS an unresolved
 *     attempt already exists for it (a double-click / concurrent repeat of
 *     this exact call), in which case that existing order is replayed
 *     verbatim, no new Razorpay API call and no new PaymentAttempt row.
 *     (Recovery's own second-attempt order creation is a SEPARATE function
 *     — see recoveryService.ts — since it has a different eligibility
 *     precondition (`status === "failed"`) and a different Razorpay-order-
 *     reuse policy.)
 *  2. The amount is derived ONLY from `Agreement.totalAmount`, read fresh
 *     from the database — never accepted as a parameter, so there is no
 *     code path by which a caller could submit their own amount.
 *  3. Currency is always "INR" (see razorpayClient.ts's own reasoning for
 *     why no currency parameter exists at all yet).
 */
export async function createOrderForAgreement(agreementId: string): Promise<PaymentOrderResponseDTO> {
  const agreement = await loadAgreementForPayment(agreementId);
  if (!agreement) {
    throw new AgreementNotFoundError(agreementId);
  }

  const existing = await findUnresolvedAttempt(agreementId);
  if (existing) {
    // Idempotent replay — see this function's own doc comment, point 1.
    return toOrderResponse(existing, rupeesToPaise(agreement.totalAmount), mockOutcomeFor(existing));
  }

  if (agreement.status !== "pending_payment") {
    throw new AgreementNotEligibleError(
      agreement.status,
      `Cannot start a payment order: Agreement status is "${agreement.status}", not "pending_payment".`,
    );
  }

  const amountPaise = rupeesToPaise(agreement.totalAmount);
  const providerOrderId = await createRazorpayOrder(agreement, amountPaise);

  const { attempt } = await createPaymentAttempt({
    agreementId,
    attemptNumber: 1,
    isRecovery: false,
    razorpayOrderId: providerOrderId,
  });

  return toOrderResponse(attempt, amountPaise, mockOutcomeFor(attempt));
}

/**
 * Calls the currently-selected provider's createOrder — the one place
 * both createOrderForAgreement and recoveryService.ts's "no existing
 * order to reuse" branch go through, so the amount-derivation +
 * order-creation-failure handling is never duplicated.
 *
 * A failure here (the Razorpay API call itself throwing — network error,
 * bad credentials, etc.) never produces a durable PaymentAttempt row: no
 * real order exists to record, and per the Milestone 13 report's own
 * reasoning, this should not consume one of the Agreement's 2 logical
 * attempts. The Agreement stays "pending_payment" so the user can simply
 * try again; only an AuditLog entry (via recordOrderCreationFailure)
 * marks that the attempt was made and failed.
 */
export async function createRazorpayOrder(agreement: AgreementForPayment, amountPaise: number): Promise<string> {
  const provider = getPaymentProvider();
  try {
    const { providerOrderId } = await provider.createOrder({
      amountPaise,
      currency: "INR",
      receipt: agreement.id,
    });
    return providerOrderId;
  } catch (error) {
    await recordOrderCreationFailure(agreement.id, error);
    throw new OrderCreationFailedError(error);
  }
}

/** Only ever populated when the mock provider is active (never in production) — see mockRazorpayAdapter.ts's header comment for why this decision belongs here, server-side, keyed on real attempt state, never on the browser. */
function mockOutcomeFor(attempt: PaymentAttemptRow): "success" | "failure" | undefined {
  if (!isMockProviderActive()) return undefined;
  // Demo sequence (Milestone 13 §16): the first logical attempt always
  // simulates failure, the recovery attempt always simulates success —
  // deterministic, never randomized.
  return attempt.isRecovery ? "success" : "failure";
}

export interface VerifyCheckoutInput {
  razorpayOrderId: string;
  /** Present together with razorpaySignature only on a genuine success claim — see this file's own header comment on why a reported FAILURE needs no signature at all (it grants nothing, so there is nothing to forge). */
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  /** Present only on a client-reported failure (Razorpay's own checkout `payment.failed` event code) — classified via classifyCheckoutFailure, never trusted beyond that classification. */
  reportedFailureCode?: string;
}

/**
 * Resolves the Agreement's currently-unresolved PaymentAttempt from a
 * checkout-response report — either a genuine success claim (verified
 * cryptographically before ever being accepted) or a client-reported
 * failure (recorded as-is; a failure claim needs no proof since it
 * unlocks nothing). Never marks an Agreement "paid" except through a
 * signature that verified successfully against the ACTUAL provider
 * (real or mock) currently configured.
 *
 * The PaymentAttempt being resolved is located ENTIRELY server-side —
 * `findUnresolvedAttempt(agreementId)` — and its own stored
 * `razorpayOrderId` is cross-checked against what the browser submitted
 * (`input.razorpayOrderId`); a mismatch (wrong order, stale/replayed
 * request, or an attempt to verify one Agreement's payment against
 * another's order) is rejected outright as VerificationMismatchError,
 * never partially trusted.
 */
export async function verifyCheckoutPayment(
  agreementId: string,
  input: VerifyCheckoutInput,
): Promise<PaymentVerifyResponseDTO> {
  const agreement = await loadAgreementForPayment(agreementId);
  if (!agreement) {
    throw new AgreementNotFoundError(agreementId);
  }

  const attempt = await findUnresolvedAttempt(agreementId);
  if (!attempt || attempt.razorpayOrderId !== input.razorpayOrderId) {
    throw new VerificationMismatchError();
  }

  await recordVerificationStarted(agreementId, attempt.id);

  let result;
  if (input.razorpayPaymentId && input.razorpaySignature) {
    const provider = getPaymentProvider();
    const valid = provider.verifyCheckoutSignature({
      providerOrderId: attempt.razorpayOrderId as string,
      providerPaymentId: input.razorpayPaymentId,
      signature: input.razorpaySignature,
    });
    result = valid
      ? await resolvePaymentAttempt({ attempt, outcome: "success", razorpayPaymentId: input.razorpayPaymentId, source: "verify" })
      : await resolvePaymentAttempt({ attempt, outcome: "failed", failureReason: "verification_failed", source: "verify" });
  } else {
    const failureReason = classifyCheckoutFailure(input.reportedFailureCode);
    result = await resolvePaymentAttempt({ attempt, outcome: "failed", failureReason, source: "verify" });
  }

  return {
    attemptStatus: result.attemptStatus === "created" ? "failed" : result.attemptStatus,
    agreementStatus: result.agreementStatus,
    failureReason: result.attemptStatus === "failed" ? deriveFailureReasonForResponse(input) : undefined,
    recoveryAvailable: result.agreementStatus === "failed" && attempt.attemptNumber < MAX_LOGICAL_PAYMENT_ATTEMPTS,
  };
}

function deriveFailureReasonForResponse(input: VerifyCheckoutInput): PaymentFailureReason {
  if (input.razorpayPaymentId && input.razorpaySignature) return "verification_failed";
  return classifyCheckoutFailure(input.reportedFailureCode);
}

/** GET .../payment — a safe, read-only status summary. Never leaks a signature, secret, or raw provider payload. */
export async function getPaymentStatus(agreementId: string): Promise<PaymentStatusResponseDTO> {
  const agreement = await loadAgreementForPayment(agreementId);
  if (!agreement) {
    throw new AgreementNotFoundError(agreementId);
  }
  const attempts = await listPaymentAttempts(agreementId);
  const unresolved = attempts.find((a) => a.status === "created") ?? null;

  const attemptDTOs: PaymentAttemptDTO[] = attempts.map((a) => ({
    attemptNumber: a.attemptNumber,
    isRecovery: a.isRecovery,
    status: a.status,
    ...(a.failureReason ? { failureReason: a.failureReason as PaymentFailureReason } : {}),
  }));

  return {
    agreementStatus: agreement.status,
    attempts: attemptDTOs,
    recoveryAvailable: agreement.status === "failed" && attempts.length < MAX_LOGICAL_PAYMENT_ATTEMPTS,
    maxAttempts: MAX_LOGICAL_PAYMENT_ATTEMPTS,
    currentRazorpayOrderId: unresolved?.razorpayOrderId ?? null,
  };
}

// Re-exported so route handlers / recoveryService.ts never need their own
// import of the mock signature constant just to construct a mock success
// request — kept here rather than duplicated.
export { MOCK_VALID_SIGNATURE };
