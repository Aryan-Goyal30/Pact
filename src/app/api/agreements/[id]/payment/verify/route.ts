import { verifyCheckoutPayment, AgreementNotFoundError, VerificationMismatchError } from "@/lib/payment/paymentService";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface VerifyRequestBody {
  razorpayOrderId?: unknown;
  razorpayPaymentId?: unknown;
  razorpaySignature?: unknown;
  reportedFailureCode?: unknown;
}

// POST /api/agreements/:id/payment/verify — resolves the Agreement's
// current payment attempt from the browser's checkout result: either a
// success claim (razorpay_payment_id + razorpay_signature, verified
// cryptographically server-side before ever being trusted — see
// paymentService.ts) or a reported failure (no signature required, since
// a failure claim unlocks nothing). Never marks anything "paid" on a
// failed or missing signature check.
export async function POST(request: Request, context: RouteContext<"/api/agreements/[id]/payment/verify">) {
  const { id } = await context.params;

  let body: VerifyRequestBody;
  try {
    body = (await request.json()) as VerifyRequestBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  if (typeof body.razorpayOrderId !== "string" || body.razorpayOrderId.length === 0) {
    return jsonResponse({ error: "razorpayOrderId is required." }, 400);
  }

  try {
    const result = await verifyCheckoutPayment(id, {
      razorpayOrderId: body.razorpayOrderId,
      razorpayPaymentId: typeof body.razorpayPaymentId === "string" ? body.razorpayPaymentId : undefined,
      razorpaySignature: typeof body.razorpaySignature === "string" ? body.razorpaySignature : undefined,
      reportedFailureCode: typeof body.reportedFailureCode === "string" ? body.reportedFailureCode : undefined,
    });
    return jsonResponse(result, 200);
  } catch (error) {
    if (error instanceof AgreementNotFoundError) {
      return jsonResponse({ error: error.message }, 404);
    }
    if (error instanceof VerificationMismatchError) {
      return jsonResponse({ error: error.message }, 400);
    }
    console.error("Payment verification failed:", error);
    return jsonResponse({ error: "Could not verify the payment." }, 500);
  }
}
