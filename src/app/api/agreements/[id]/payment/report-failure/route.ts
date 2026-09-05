import { reportCheckoutFailure, AgreementNotFoundError } from "@/lib/payment/paymentService";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface ReportFailureRequestBody {
  razorpayOrderId?: unknown;
  errorCode?: unknown;
  errorDescription?: unknown;
  reportedPaymentId?: unknown;
}

// POST /api/agreements/:id/payment/report-failure — M13.2. Records a
// browser-observed Razorpay Checkout `payment.failed` event for
// audit/diagnostics ONLY — never resolves, never terminalizes, requires
// no signature (a mere decline report unlocks/forecloses nothing). See
// paymentService.ts's reportCheckoutFailure for the full reasoning:
// Razorpay's Checkout `retry` option defaults to enabled (PACT never
// disables it), so the modal may stay open and later receive a genuine
// success against the SAME order after one or more declines — this
// endpoint exists so a decline can be logged without ever pre-empting
// that later success (the exact real-provider bug this milestone fixes).
export async function POST(request: Request, context: RouteContext<"/api/agreements/[id]/payment/report-failure">) {
  const { id } = await context.params;

  let body: ReportFailureRequestBody;
  try {
    body = (await request.json()) as ReportFailureRequestBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  if (typeof body.razorpayOrderId !== "string" || body.razorpayOrderId.length === 0) {
    return jsonResponse({ error: "razorpayOrderId is required." }, 400);
  }

  try {
    await reportCheckoutFailure(id, {
      razorpayOrderId: body.razorpayOrderId,
      errorCode: typeof body.errorCode === "string" ? body.errorCode : undefined,
      errorDescription: typeof body.errorDescription === "string" ? body.errorDescription : undefined,
      reportedPaymentId: typeof body.reportedPaymentId === "string" ? body.reportedPaymentId : undefined,
    });
    return jsonResponse({ recorded: true }, 200);
  } catch (error) {
    if (error instanceof AgreementNotFoundError) {
      return jsonResponse({ error: error.message }, 404);
    }
    console.error("Failed to record a reported checkout failure:", error);
    return jsonResponse({ error: "Could not record the reported failure." }, 500);
  }
}
