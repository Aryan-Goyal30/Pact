// Read-only Audit Trail retrieval — Roadmap milestone: a real, persisted
// audit trail viewer for the negotiation demo.
//
// This module WRITES NOTHING — every AuditLog row it reads was already
// persisted by existing, unmodified write paths:
//   - negotiationSessionRepository.ts -> AUDIT_EVENT_NEGOTIATION_DECISION
//     (sessionId only)
//   - agreementRepository.ts -> AUDIT_EVENT_AGREEMENT_CREATED
//     (both sessionId AND agreementId)
//   - paymentRepository.ts -> PAYMENT_*/RECOVERY_*/WEBHOOK_RECEIVED
//     (agreementId (+paymentAttemptId) only — never sessionId)
// See prisma/schema.prisma's own AuditLog model comment for the same
// summary. Nothing here decides, recomputes, or influences a single
// negotiated number — it only reads back what those paths already
// committed, in the shape they already committed it.

import { prisma } from "@/lib/prisma";
import { AUDIT_EVENT_NEGOTIATION_DECISION } from "@/lib/negotiation/negotiationSessionRepository";
import type { TurnDecisionAudit } from "@/lib/negotiation/agentDecision";

/**
 * One persisted AuditLog row for a negotiation, read back as-is.
 *
 * For `eventType === "NEGOTIATION_DECISION"`: `turn`/`decision` are
 * populated — `decision` is the EXACT `TurnDecisionAudit` shape
 * negotiationSessionRepository.ts already persisted (see agentDecision.ts)
 * — never a new or parallel decision schema. `payload` is absent.
 *
 * For every other event type (AGREEMENT_CREATED, PAYMENT_*, RECOVERY_*,
 * WEBHOOK_RECEIVED): `payload` is the row's own already-persisted JSON,
 * parsed and returned as plain business facts. `turn`/`decision` are
 * absent.
 *
 * If a row's payload cannot be parsed as JSON (should never happen given
 * every writer above always JSON.stringifies a real object, but never
 * trusted blindly), `payload` becomes a small, explicit error marker
 * instead of throwing — a malformed row must never take down the whole
 * audit trail.
 */
export interface AuditTrailEntry {
  id: string;
  eventType: string;
  createdAt: Date;
  turn?: number;
  decision?: TurnDecisionAudit;
  payload?: Record<string, unknown>;
}

/** Loosely shaped as `unknown` on purpose — a persisted payload is never trusted to actually match TurnDecisionAudit's shape without checking. */
function looksLikeNegotiationDecisionPayload(
  value: unknown,
): value is { turn: number } & TurnDecisionAudit {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).turn === "number" &&
    typeof (value as Record<string, unknown>).buyer === "object" &&
    (value as Record<string, unknown>).buyer !== null
  );
}

function toAuditTrailEntry(row: {
  id: string;
  eventType: string;
  createdAt: Date;
  payload: string;
}): AuditTrailEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    // Defensive only — every existing writer always JSON.stringifies a
    // real object, so this should never fire in practice. A malformed
    // row is still a REAL persisted event; it must still appear in the
    // timeline, just without business facts to show.
    return {
      id: row.id,
      eventType: row.eventType,
      createdAt: row.createdAt,
      payload: { error: "This event's payload could not be read." },
    };
  }

  if (row.eventType === AUDIT_EVENT_NEGOTIATION_DECISION && looksLikeNegotiationDecisionPayload(parsed)) {
    const { turn, ...decision } = parsed;
    return { id: row.id, eventType: row.eventType, createdAt: row.createdAt, turn, decision };
  }

  return {
    id: row.id,
    eventType: row.eventType,
    createdAt: row.createdAt,
    payload:
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed },
  };
}

/**
 * Every AuditLog row associated with one negotiation session, oldest
 * first. Two families of rows are joined together:
 *  - rows carrying `sessionId` directly (NEGOTIATION_DECISION, and
 *    AGREEMENT_CREATED, which carries both);
 *  - rows carrying only `agreementId` (every payment/recovery/webhook
 *    event) — reached via the Agreement -> sessionId relation, since
 *    Agreement.sessionId is unique (one negotiation, at most one
 *    agreement).
 * A negotiation with no agreement yet simply has no rows in the second
 * family — nothing is fabricated to fill the gap; the timeline just
 * stops at whatever genuinely happened.
 */
export async function listAuditTrail(sessionId: string): Promise<AuditTrailEntry[]> {
  const rows = await prisma.auditLog.findMany({
    where: { OR: [{ sessionId }, { agreement: { sessionId } }] },
    orderBy: { createdAt: "asc" },
  });

  return rows.map(toAuditTrailEntry);
}
