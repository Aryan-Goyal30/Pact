import { listAuditTrail } from "@/lib/negotiation/auditTrailRepository";
import type { AuditTrailResponse } from "@/types/negotiation";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// GET /api/negotiations/:id/audit-trail — read-only retrieval of the
// PERSISTED AuditLog history for one negotiation session (see
// auditTrailRepository.ts). Mirrors GET .../agreement's own minimal
// style: no session-existence check of its own — an unknown or
// not-yet-decided session id simply returns an empty `entries` array,
// the same "don't try to distinguish, the caller only needs the data
// either way" philosophy that route already established. Never writes
// anything; never touches negotiation state.
export async function GET(
  _request: Request,
  context: RouteContext<"/api/negotiations/[id]/audit-trail">,
) {
  const { id } = await context.params;

  try {
    const entries = await listAuditTrail(id);
    const response: AuditTrailResponse = {
      sessionId: id,
      entries: entries.map((entry) => ({
        ...entry,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
    return jsonResponse(response, 200);
  } catch (error) {
    console.error("Failed to load audit trail:", error);
    return jsonResponse({ error: "Could not load the audit trail." }, 500);
  }
}
