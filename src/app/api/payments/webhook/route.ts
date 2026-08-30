import { verifyWebhookSignature } from "@/lib/payment/razorpayClient";
import {
  findUnresolvedAttemptByOrderId,
  hasWebhookEventBeenProcessed,
  recordWebhookReceived,
} from "@/lib/payment/paymentRepository";
import { resolvePaymentAttempt } from "@/lib/payment/paymentRepository";
import { classifyCheckoutFailure } from "@/lib/payment/paymentFailure";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RazorpayWebhookPayload {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        error_code?: string;
      };
    };
  };
}

const SUCCESS_EVENTS = new Set(["payment.captured", "order.paid"]);
const FAILURE_EVENTS = new Set(["payment.failed"]);

// POST /api/payments/webhook — Razorpay-initiated, server-to-server. NOT
// nested under /api/agreements/:id/, since Razorpay calls this with no
// knowledge of PACT's own resource hierarchy — the Agreement is derived
// entirely from the event payload's own order id (see
// findUnresolvedAttemptByOrderId). This is the authoritative,
// server-side reconciliation path (Milestone 13 architecture review §H):
// unlike checkout-response verification, this is never something the
// browser can influence at all.
//
// Uses RAZORPAY_WEBHOOK_SECRET — a distinct secret from RAZORPAY_KEY_SECRET
// (Razorpay issues webhook secrets separately, per configured endpoint).
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature");
  const eventId = request.headers.get("x-razorpay-event-id");

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("RAZORPAY_WEBHOOK_SECRET is not configured — rejecting webhook.");
    return jsonResponse({ error: "Webhook is not configured." }, 500);
  }

  if (!signature || !verifyWebhookSignature(rawBody, signature, secret)) {
    console.warn("Rejected a webhook request with a missing or invalid signature.");
    return jsonResponse({ error: "Invalid signature." }, 400);
  }

  let payload: RazorpayWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as RazorpayWebhookPayload;
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  // Razorpay always includes this header in practice; if it were ever
  // absent, falling back to a body-derived value keeps dedup working
  // rather than either crashing or silently disabling idempotency.
  const effectiveEventId = eventId ?? `no-event-id:${rawBody.length}:${payload.event ?? "unknown"}`;

  if (await hasWebhookEventBeenProcessed(effectiveEventId)) {
    // Duplicate delivery — a safe no-op, per Razorpay's own retry
    // behavior. Never reprocessed, never a repeated error.
    return jsonResponse({ status: "ok" }, 200);
  }

  const eventType = payload.event ?? "unknown";
  const orderId = payload.payload?.payment?.entity?.order_id;
  const paymentId = payload.payload?.payment?.entity?.id;

  if (!orderId) {
    // Nothing actionable (an event type this integration doesn't cover,
    // or a malformed payload) — still recorded, so a repeat delivery of
    // this exact event is recognized next time too.
    await recordWebhookReceived({ eventId: effectiveEventId, eventType, rawPayload: payload });
    return jsonResponse({ status: "ok" }, 200);
  }

  const attempt = await findUnresolvedAttemptByOrderId(orderId);
  if (!attempt) {
    // No currently-unresolved attempt for this order — either already
    // settled by the other path, or an order this deployment has no
    // record of. Never an error; still recorded for idempotency.
    await recordWebhookReceived({ eventId: effectiveEventId, eventType, rawPayload: payload });
    return jsonResponse({ status: "ok" }, 200);
  }

  if (SUCCESS_EVENTS.has(eventType)) {
    await resolvePaymentAttempt({ attempt, outcome: "success", razorpayPaymentId: paymentId, source: "webhook" });
  } else if (FAILURE_EVENTS.has(eventType)) {
    const failureReason = classifyCheckoutFailure(payload.payload?.payment?.entity?.error_code);
    await resolvePaymentAttempt({ attempt, outcome: "failed", failureReason, source: "webhook" });
  }
  // Any other event type: recorded (below) but no state transition — see
  // this route's own comment on SUCCESS_EVENTS/FAILURE_EVENTS being the
  // only two outcomes PACT's current flow needs to act on (Milestone 13
  // §"payment events": implement only what the chosen flow requires,
  // never a giant provider-event enum).

  await recordWebhookReceived({
    eventId: effectiveEventId,
    eventType,
    agreementId: attempt.agreementId,
    paymentAttemptId: attempt.id,
    rawPayload: payload,
  });

  return jsonResponse({ status: "ok" }, 200);
}
