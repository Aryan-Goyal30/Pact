import { startRecovery, RecoveryLimitExceededError } from "@/lib/payment/recoveryService";
import { AgreementNotEligibleError, AgreementNotFoundError, OrderCreationFailedError } from "@/lib/payment/paymentService";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// POST /api/agreements/:id/payment/recover — user-triggered only (the
// "Retry payment" button; nothing in this codebase calls this
// automatically). Starts the single bounded recovery attempt for a
// failed Agreement — see recoveryService.ts for eligibility rules and
// Razorpay order-reuse semantics. Takes no body, same reasoning as
// .../payment/order.
export async function POST(_request: Request, context: RouteContext<"/api/agreements/[id]/payment/recover">) {
  const { id } = await context.params;

  try {
    const order = await startRecovery(id);
    return jsonResponse(order, 200);
  } catch (error) {
    if (error instanceof AgreementNotFoundError) {
      return jsonResponse({ error: error.message }, 404);
    }
    if (error instanceof AgreementNotEligibleError) {
      return jsonResponse({ error: error.message }, 409);
    }
    if (error instanceof RecoveryLimitExceededError) {
      return jsonResponse({ error: error.message }, 409);
    }
    if (error instanceof OrderCreationFailedError) {
      return jsonResponse({ error: error.message, failureReason: error.reason }, 502);
    }
    console.error("Payment recovery failed:", error);
    return jsonResponse({ error: "Could not start payment recovery." }, 500);
  }
}
