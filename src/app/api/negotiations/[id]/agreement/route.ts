import { getAgreementBySessionId } from "@/lib/negotiation/agreementRepository";
import type { PersistedAgreementDTO } from "@/types/negotiation";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// GET /api/negotiations/:id/agreement — looks up the Agreement (if any)
// for a negotiation session. Minimal on purpose: a future payment
// milestone needs a safe way to re-fetch a session's agreed terms
// without re-running the negotiation, and POST /api/negotiations/:id/turn
// already returns this same shape inline on the turn that reaches
// AGREED — this route just makes that lookup independently repeatable.
// Returns null (not 404) when the session exists but has no agreement
// yet (still negotiating, or ended REJECTED/EXPIRED) — 404 is reserved
// for an unknown session id, which this route cannot distinguish from
// "no agreement yet" without an extra query, so it deliberately doesn't
// try; the caller only needs "is there an agreement" either way.
export async function GET(_request: Request, context: RouteContext<"/api/negotiations/[id]/agreement">) {
  const { id } = await context.params;

  try {
    const agreement = await getAgreementBySessionId(id);
    const response: { agreement: PersistedAgreementDTO | null } = {
      agreement: agreement
        ? {
            id: agreement.id,
            sku: agreement.sku,
            quantity: agreement.quantity,
            unitPrice: agreement.unitPrice,
            deliveryDays: agreement.deliveryDays,
            totalAmount: agreement.totalAmount,
            status: agreement.status,
          }
        : null,
    };
    return jsonResponse(response, 200);
  } catch (error) {
    console.error("Failed to load agreement:", error);
    return jsonResponse({ error: "Could not load the agreement." }, 500);
  }
}
