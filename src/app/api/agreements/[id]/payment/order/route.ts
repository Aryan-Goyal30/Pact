import { createOrderForAgreement, AgreementNotEligibleError, AgreementNotFoundError, OrderCreationFailedError } from "@/lib/payment/paymentService";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// POST /api/agreements/:id/payment/order — creates (or idempotently
// replays) the Razorpay order for an Agreement's first payment attempt.
// Takes no body: the amount is derived exclusively from the Agreement's
// own totalAmount (see paymentService.ts) — nothing a client could submit
// here would ever be read, so this route deliberately never parses the
// request body at all. Call this once, on the user's "Pay Now" click.
export async function POST(_request: Request, context: RouteContext<"/api/agreements/[id]/payment/order">) {
  const { id } = await context.params;

  try {
    const order = await createOrderForAgreement(id);
    return jsonResponse(order, 200);
  } catch (error) {
    if (error instanceof AgreementNotFoundError) {
      return jsonResponse({ error: error.message }, 404);
    }
    if (error instanceof AgreementNotEligibleError) {
      return jsonResponse({ error: error.message }, 409);
    }
    if (error instanceof OrderCreationFailedError) {
      return jsonResponse({ error: error.message, failureReason: error.reason }, 502);
    }
    console.error("Payment order creation failed:", error);
    return jsonResponse({ error: "Could not create the payment order." }, 500);
  }
}
