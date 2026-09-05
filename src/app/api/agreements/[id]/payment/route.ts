import { getPaymentStatus, AgreementNotFoundError } from "@/lib/payment/paymentService";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// GET /api/agreements/:id/payment — a safe, read-only payment status
// summary (mirrors GET /api/negotiations/:id/agreement's own minimal,
// re-fetchable-anytime shape). Never leaks a secret, a signature, or any
// raw provider payload — see types/payment.ts's PaymentStatusResponseDTO.
export async function GET(_request: Request, context: RouteContext<"/api/agreements/[id]/payment">) {
  const { id } = await context.params;

  try {
    const status = await getPaymentStatus(id);
    return jsonResponse(status, 200);
  } catch (error) {
    if (error instanceof AgreementNotFoundError) {
      return jsonResponse({ error: error.message }, 404);
    }
    console.error("Failed to load payment status:", error);
    return jsonResponse({ error: "Could not load the payment status." }, 500);
  }
}
