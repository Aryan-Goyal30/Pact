// Payment persistence — PACT V2 Milestone 13.
//
// The only file that writes PaymentAttempt rows or payment-related
// AuditLog rows (mirrors agreementRepository.ts's role for Agreement/
// AGREEMENT_CREATED exactly — one file owns one table's writes). Reuses
// the Agreement and AuditLog tables exactly as they already exist; no
// schema change (see this milestone's own report for why one genuinely
// wasn't needed).
//
// Every write here follows the SAME two disciplines
// agreementRepository.ts already established:
//
//  1. Idempotent creation via a DETERMINISTIC id + a P2002 catch-and-refetch,
//     never a naive "SELECT then INSERT" (see createPaymentAttempt below) —
//     the database's own primary-key uniqueness is the real guarantee,
//     not application-level sequencing.
//  2. Conditional updates keyed on expected prior state (`WHERE status = ...`),
//     never a blind overwrite (see resolvePaymentAttempt below) — this is
//     what makes a duplicate webhook, a delayed webhook, or a stale
//     checkout-response verification a safe no-op instead of a state
//     regression.

import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { PaymentFailureReason } from "@/lib/payment/paymentFailure";

export const AUDIT_EVENT_PAYMENT_ORDER_CREATED = "PAYMENT_ORDER_CREATED";
export const AUDIT_EVENT_PAYMENT_VERIFICATION_STARTED = "PAYMENT_VERIFICATION_STARTED";
export const AUDIT_EVENT_PAYMENT_SUCCEEDED = "PAYMENT_SUCCEEDED";
export const AUDIT_EVENT_PAYMENT_FAILED = "PAYMENT_FAILED";
export const AUDIT_EVENT_RECOVERY_STARTED = "RECOVERY_STARTED";
export const AUDIT_EVENT_RECOVERY_SUCCEEDED = "RECOVERY_SUCCEEDED";
export const AUDIT_EVENT_RECOVERY_FAILED = "RECOVERY_FAILED";
export const AUDIT_EVENT_WEBHOOK_RECEIVED = "WEBHOOK_RECEIVED";
/**
 * M13.2 — a browser-observed Razorpay Checkout `payment.failed` event,
 * recorded PURELY for audit/diagnostics. Deliberately distinct from
 * AUDIT_EVENT_PAYMENT_FAILED (which only ever accompanies an actual
 * terminal state transition inside resolvePaymentAttempt) — this event
 * type means the opposite: NOTHING was transitioned. See
 * recordReportedCheckoutFailure's own comment for why.
 */
export const AUDIT_EVENT_PAYMENT_FAILURE_REPORTED = "PAYMENT_FAILURE_REPORTED";

export type AgreementPaymentStatus = "pending_payment" | "paid" | "failed" | "recovered" | "closed";
export type PaymentAttemptStatus = "created" | "success" | "failed";

export interface PaymentAttemptRow {
  id: string;
  agreementId: string;
  attemptNumber: number;
  isRecovery: boolean;
  razorpayOrderId: string | null;
  status: PaymentAttemptStatus;
  failureReason: string | null;
  createdAt: Date;
}

export interface AgreementForPayment {
  id: string;
  totalAmount: number;
  status: AgreementPaymentStatus;
}

/** Loads the fields payment logic needs from an Agreement — never quantity/pricePerUnit/deliveryDays/catalogItemId, which payment code has no business reading (it never derives anything from them). */
export async function loadAgreementForPayment(agreementId: string): Promise<AgreementForPayment | null> {
  const row = await prisma.agreement.findUnique({
    where: { id: agreementId },
    select: { id: true, totalAmount: true, status: true },
  });
  return row ? { id: row.id, totalAmount: row.totalAmount, status: row.status as AgreementPaymentStatus } : null;
}

/** Every PaymentAttempt for an Agreement, oldest first — used by the payment-status endpoint and recovery eligibility checks. */
export async function listPaymentAttempts(agreementId: string): Promise<PaymentAttemptRow[]> {
  const rows = await prisma.paymentAttempt.findMany({
    where: { agreementId },
    orderBy: { attemptNumber: "asc" },
  });
  return rows.map(toAttemptRow);
}

/**
 * The single currently-unresolved (status="created") PaymentAttempt for
 * an Agreement, if any. By construction (createPaymentAttempt's own
 * deterministic id + the eligibility gates in paymentService.ts /
 * recoveryService.ts, which only ever create a new attempt once the
 * prior one has settled), there is never more than one such row at a
 * time. This is both the idempotency check order creation uses (replay
 * the existing order instead of creating a second one) and the lookup
 * checkout verification / the webhook use to find "the" attempt a
 * browser-submitted or Razorpay-reported order id refers to — deliberately
 * NOT a bare `findFirst({ razorpayOrderId })`, since a recovery attempt
 * may legitimately share its razorpayOrderId with the original attempt
 * it's reusing (see recoveryService.ts) and a bare order-id lookup would
 * then be ambiguous between the two.
 */
export async function findUnresolvedAttempt(agreementId: string): Promise<PaymentAttemptRow | null> {
  const row = await prisma.paymentAttempt.findFirst({
    where: { agreementId, status: "created" },
    orderBy: { attemptNumber: "desc" },
  });
  return row ? toAttemptRow(row) : null;
}

/**
 * The unresolved (status="created") PaymentAttempt currently associated
 * with a given Razorpay order id, regardless of which Agreement it
 * belongs to — used ONLY by the webhook handler, which (unlike checkout
 * verification) never receives an Agreement id from its caller at all;
 * the order id is the only correlation Razorpay's own payload provides.
 * Unambiguous for the same reason findUnresolvedAttempt is: even when a
 * recovery attempt reuses attempt #1's own razorpayOrderId (see
 * recoveryService.ts), at most one row sharing that order id is ever
 * "created" (unresolved) at a time — the other has already settled.
 */
export async function findUnresolvedAttemptByOrderId(razorpayOrderId: string): Promise<PaymentAttemptRow | null> {
  const row = await prisma.paymentAttempt.findFirst({
    where: { razorpayOrderId, status: "created" },
    orderBy: { attemptNumber: "desc" },
  });
  return row ? toAttemptRow(row) : null;
}

function toAttemptRow(row: {
  id: string;
  agreementId: string;
  attemptNumber: number;
  isRecovery: boolean;
  razorpayOrderId: string | null;
  status: string;
  failureReason: string | null;
  createdAt: Date;
}): PaymentAttemptRow {
  return {
    id: row.id,
    agreementId: row.agreementId,
    attemptNumber: row.attemptNumber,
    isRecovery: row.isRecovery,
    razorpayOrderId: row.razorpayOrderId,
    status: row.status as PaymentAttemptStatus,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
  };
}

/**
 * A fixed, deterministic id for the Nth PaymentAttempt of one Agreement
 * — e.g. "ag_abc123-attempt-1". This (not a business-column unique
 * constraint, and not a new schema migration) is what makes
 * createPaymentAttempt idempotent: two concurrent calls to create
 * attempt N for the same Agreement collide on the SAME primary key, so
 * the database itself — via Prisma's P2002 unique-constraint violation
 * on the existing `@id` column — guarantees only one ever succeeds,
 * exactly mirroring agreementRepository.ts's own
 * `Agreement.sessionId @unique` + P2002-catch-and-refetch mechanism, just
 * keyed on a derived id instead of a naturally-unique business column.
 * Portable across any SQL backend/deployment topology — it does not rely
 * on this project's current single-process SQLite concurrency model.
 */
function deterministicAttemptId(agreementId: string, attemptNumber: number): string {
  return `${agreementId}-attempt-${attemptNumber}`;
}

export interface CreatePaymentAttemptInput {
  agreementId: string;
  attemptNumber: number;
  isRecovery: boolean;
  razorpayOrderId: string;
}

/**
 * Creates a PaymentAttempt (+ its own AuditLog row, one transaction) —
 * or, if one with this exact (agreementId, attemptNumber) already exists
 * (a concurrent duplicate request, or a client retrying the same
 * order-creation call), returns the existing row instead. `created`
 * tells the caller which happened; the returned attempt is the same
 * shape either way, so callers never need to branch on it themselves.
 */
export async function createPaymentAttempt(
  input: CreatePaymentAttemptInput,
): Promise<{ attempt: PaymentAttemptRow; created: boolean }> {
  const id = deterministicAttemptId(input.agreementId, input.attemptNumber);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const attempt = await tx.paymentAttempt.create({
        data: {
          id,
          agreementId: input.agreementId,
          attemptNumber: input.attemptNumber,
          isRecovery: input.isRecovery,
          razorpayOrderId: input.razorpayOrderId,
          status: "created",
        },
      });
      await tx.auditLog.create({
        data: {
          eventType: input.isRecovery ? AUDIT_EVENT_RECOVERY_STARTED : AUDIT_EVENT_PAYMENT_ORDER_CREATED,
          agreementId: input.agreementId,
          paymentAttemptId: attempt.id,
          payload: JSON.stringify({
            razorpayOrderId: input.razorpayOrderId,
            attemptNumber: input.attemptNumber,
            isRecovery: input.isRecovery,
          }),
        },
      });
      return attempt;
    });
    return { attempt: toAttemptRow(created), created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.paymentAttempt.findUnique({ where: { id } });
      if (existing) {
        return { attempt: toAttemptRow(existing), created: false };
      }
    }
    throw error;
  }
}

/** Records that a checkout verification attempt started — informational only, never gates anything; a caller that never gets this far (e.g. rejected before reaching Razorpay) never writes it. */
export async function recordVerificationStarted(agreementId: string, paymentAttemptId: string): Promise<void> {
  await prisma.auditLog.create({
    data: {
      eventType: AUDIT_EVENT_PAYMENT_VERIFICATION_STARTED,
      agreementId,
      paymentAttemptId,
      payload: JSON.stringify({}),
    },
  });
}

export interface ResolvePaymentAttemptInput {
  attempt: PaymentAttemptRow;
  outcome: "success" | "failed";
  failureReason?: PaymentFailureReason;
  /** Razorpay's own payment id — recorded in AuditLog.payload only (no dedicated column exists, and none is needed — see this milestone's report). Never persisted for a failed outcome, since none may exist. */
  razorpayPaymentId?: string;
  source: "verify" | "webhook";
}

export interface ResolvePaymentAttemptResult {
  /** False when this call was a no-op — the attempt had already settled (success or failed) before this call, e.g. a duplicate webhook or a repeated verification. The attempt/agreement rows are returned either way, reflecting whatever the ACTUAL current state is (not necessarily this call's own requested outcome). */
  applied: boolean;
  attemptStatus: PaymentAttemptStatus;
  agreementStatus: AgreementPaymentStatus;
}

/**
 * The single state-transition function every payment-resolving code path
 * (checkout verification AND the webhook handler) goes through — this is
 * what guarantees the two paths can never disagree or race each other
 * into a contradictory state. Two conditional updates, one transaction:
 *
 *  1. PaymentAttempt: `UPDATE ... SET status=outcome WHERE id=? AND status='created'`.
 *     If this affects 0 rows, the attempt had already settled (by the
 *     other path, or a duplicate delivery of this same one) — `applied`
 *     comes back false and NOTHING ELSE in this function runs; the
 *     already-settled state is simply re-read and returned.
 *  2. Agreement: a SEPARATE conditional update, keyed on both the
 *     expected PRIOR Agreement status and whether this is a recovery
 *     attempt (isRecovery), which together determine the correct FROM/TO
 *     pair (see the Milestone 13 architecture review §J for the full
 *     legal-transition table this encodes):
 *       - first attempt succeeds:   pending_payment -> paid
 *       - first attempt fails:      pending_payment -> failed
 *       - recovery attempt succeeds: failed -> recovered
 *       - recovery attempt fails:    failed -> failed (no write needed;
 *         Agreement is already exactly there — see the branch below)
 *     Every one of these is itself a `WHERE status = <expected-from>`
 *     conditional update — a webhook or verification call that arrives
 *     late, out of order, or after the Agreement has already moved on
 *     (e.g. a stale "failed" report arriving after "paid" was already
 *     recorded) can never regress it, because its own WHERE clause
 *     simply won't match anymore.
 *
 * Both writes, plus the corresponding AuditLog row, happen in ONE
 * transaction — a caller can never observe the PaymentAttempt settled
 * without the Agreement (or its AuditLog trail) reflecting the same fact.
 */
export async function resolvePaymentAttempt(
  input: ResolvePaymentAttemptInput,
): Promise<ResolvePaymentAttemptResult> {
  return prisma.$transaction(async (tx) => {
    const attemptUpdate = await tx.paymentAttempt.updateMany({
      where: { id: input.attempt.id, status: "created" },
      data: {
        status: input.outcome,
        failureReason: input.outcome === "failed" ? (input.failureReason ?? "unknown") : null,
      },
    });

    if (attemptUpdate.count === 0) {
      // Already settled by an earlier call (duplicate webhook, a race
      // with the checkout-response path, etc.) — a safe no-op. Re-read
      // the real current state rather than trusting this call's own
      // requested outcome, since the two might legitimately differ (e.g.
      // this call reports "failed" but the attempt was already marked
      // "success" by the webhook moments earlier).
      const currentAttempt = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: input.attempt.id } });
      const currentAgreement = await tx.agreement.findUniqueOrThrow({
        where: { id: input.attempt.agreementId },
        select: { status: true },
      });
      return {
        applied: false,
        attemptStatus: currentAttempt.status as PaymentAttemptStatus,
        agreementStatus: currentAgreement.status as AgreementPaymentStatus,
      };
    }

    const isRecovery = input.attempt.isRecovery;
    let agreementStatus: AgreementPaymentStatus;

    if (input.outcome === "success") {
      const toStatus: AgreementPaymentStatus = isRecovery ? "recovered" : "paid";
      const fromStatus: AgreementPaymentStatus = isRecovery ? "failed" : "pending_payment";
      const agreementUpdate = await tx.agreement.updateMany({
        where: { id: input.attempt.agreementId, status: fromStatus },
        data: { status: toStatus },
      });
      // If 0 rows matched, the Agreement had already moved on (e.g. it
      // somehow reached `paid`/`recovered` through the other resolution
      // path in the tiny window between this transaction's two updates —
      // structurally very unlikely given both updates share one
      // transaction, but the PaymentAttempt update above is still the
      // authoritative "did THIS call apply" signal; the Agreement's own
      // current value is read fresh regardless, never assumed).
      agreementStatus = agreementUpdate.count > 0
        ? toStatus
        : ((await tx.agreement.findUniqueOrThrow({ where: { id: input.attempt.agreementId }, select: { status: true } })).status as AgreementPaymentStatus);
    } else if (!isRecovery) {
      const agreementUpdate = await tx.agreement.updateMany({
        where: { id: input.attempt.agreementId, status: "pending_payment" },
        data: { status: "failed" },
      });
      agreementStatus = agreementUpdate.count > 0
        ? "failed"
        : ((await tx.agreement.findUniqueOrThrow({ where: { id: input.attempt.agreementId }, select: { status: true } })).status as AgreementPaymentStatus);
    } else {
      // A recovery attempt itself failing: Agreement is already "failed"
      // (that's the precondition recovery required to start at all — see
      // recoveryService.ts) and stays exactly there. No write needed —
      // still read fresh rather than assumed, for the same reason as above.
      agreementStatus = (await tx.agreement.findUniqueOrThrow({ where: { id: input.attempt.agreementId }, select: { status: true } })).status as AgreementPaymentStatus;
    }

    const eventType =
      input.outcome === "success"
        ? (isRecovery ? AUDIT_EVENT_RECOVERY_SUCCEEDED : AUDIT_EVENT_PAYMENT_SUCCEEDED)
        : (isRecovery ? AUDIT_EVENT_RECOVERY_FAILED : AUDIT_EVENT_PAYMENT_FAILED);

    await tx.auditLog.create({
      data: {
        eventType,
        agreementId: input.attempt.agreementId,
        paymentAttemptId: input.attempt.id,
        payload: JSON.stringify({
          source: input.source,
          outcome: input.outcome,
          failureReason: input.outcome === "failed" ? (input.failureReason ?? "unknown") : undefined,
          razorpayPaymentId: input.razorpayPaymentId,
        }),
      },
    });

    return { applied: true, attemptStatus: input.outcome, agreementStatus };
  });
}

export interface RecordReportedCheckoutFailureInput {
  agreementId: string;
  /** Set only when the reported razorpayOrderId matched the Agreement's currently-unresolved attempt — never invented, never guessed. */
  paymentAttemptId?: string;
  razorpayOrderId: string;
  errorCode?: string;
  errorDescription?: string;
  /** Razorpay's own `error.metadata.payment_id`, when the failed event included one — audit-only, exactly like resolvePaymentAttempt's own razorpayPaymentId field. */
  reportedPaymentId?: string;
}

/**
 * M13.2 — records a browser-observed Razorpay Checkout `payment.failed`
 * event as an AuditLog entry ONLY. This function NEVER touches a
 * PaymentAttempt or Agreement row — no status write, no failureReason
 * write, nothing.
 *
 * Why this exists as its own function, separate from resolvePaymentAttempt:
 * real Razorpay Checkout's `retry` option defaults to enabled (PACT never
 * disables it — see PaymentPanel.tsx), meaning the Checkout modal stays
 * open after a single decline and the SAME registered `handler` callback
 * may still receive a later, genuinely successful payment against the
 * SAME order_id. Terminalizing the PaymentAttempt on the first decline
 * (the pre-M13.2 behavior) meant that later real success could never be
 * matched by findUnresolvedAttempt anymore, and was rejected outright —
 * this was confirmed against real Razorpay Test Mode (Order=Paid,
 * PACT=failed). A decline while Checkout may still be open is therefore
 * informational, not authoritative: only a verified signature
 * (resolvePaymentAttempt via verifyCheckoutPayment) or an authoritative
 * webhook may ever move PaymentAttempt/Agreement to a terminal state.
 *
 * Never throws on a mismatched/stale/unmatched order id — see this
 * function's only caller (paymentService.ts's reportCheckoutFailure) for
 * why a failure REPORT must never be capable of rejecting anything.
 */
export async function recordReportedCheckoutFailure(input: RecordReportedCheckoutFailureInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      eventType: AUDIT_EVENT_PAYMENT_FAILURE_REPORTED,
      agreementId: input.agreementId,
      paymentAttemptId: input.paymentAttemptId,
      payload: JSON.stringify({
        razorpayOrderId: input.razorpayOrderId,
        errorCode: input.errorCode,
        errorDescription: input.errorDescription,
        reportedPaymentId: input.reportedPaymentId,
      }),
    },
  });
}

/**
 * Records an order-creation failure that never produced a durable
 * PaymentAttempt row at all (the Razorpay API call itself failed, before
 * any DB write) — Agreement stays "pending_payment" (nothing was ever
 * really attempted from Razorpay's perspective) and this does NOT count
 * against the 2-attempt recovery budget. See paymentService.ts's own
 * comment on createOrderForAgreement for the full reasoning.
 */
export async function recordOrderCreationFailure(agreementId: string, detail: unknown): Promise<void> {
  await prisma.auditLog.create({
    data: {
      eventType: AUDIT_EVENT_PAYMENT_FAILED,
      agreementId,
      payload: JSON.stringify({ failureReason: "order_creation_failed", detail: String(detail) }),
    },
  });
}

/**
 * Webhook event idempotency (Milestone 13 §I) — deliberately reuses
 * AuditLog rather than a new table, per the explicit project instruction.
 * `eventId` (Razorpay's own `x-razorpay-event-id` header value) is
 * embedded in the WEBHOOK_RECEIVED row's JSON payload; a repeat delivery
 * of the same event is detected with a plain substring match on that
 * column — SQLite-portable, no JSON functions required, and correct
 * because eventId is itself vetted (see the webhook route) to never
 * contain characters that could produce a false-positive substring match
 * against a DIFFERENT event's id before this check runs.
 */
export async function hasWebhookEventBeenProcessed(eventId: string): Promise<boolean> {
  const existing = await prisma.auditLog.findFirst({
    where: { eventType: AUDIT_EVENT_WEBHOOK_RECEIVED, payload: { contains: `"eventId":"${eventId}"` } },
    select: { id: true },
  });
  return existing !== null;
}

/** Records that a webhook event was received (and, informationally, what PACT did with it) — always written, even for an event PACT ultimately took no action on (e.g. one whose order id matches no known attempt), so hasWebhookEventBeenProcessed can still recognize a repeat delivery of it. */
export async function recordWebhookReceived(input: {
  eventId: string;
  eventType: string;
  agreementId?: string;
  paymentAttemptId?: string;
  rawPayload: unknown;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      eventType: AUDIT_EVENT_WEBHOOK_RECEIVED,
      agreementId: input.agreementId,
      paymentAttemptId: input.paymentAttemptId,
      payload: JSON.stringify({ eventId: input.eventId, razorpayEventType: input.eventType, rawPayload: input.rawPayload }),
    },
  });
}
