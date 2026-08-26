// Agreement + completion-audit persistence — reuses the Agreement and
// AuditLog tables Phase 1 already defined for exactly this purpose. No
// schema changes were needed: Agreement.sessionId has been `@unique`
// since the very first migration (20260824222204_init), which is what
// makes this idempotent — see ensureAgreementForSession below.

import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";

/** The event type recorded in AuditLog when a negotiation's Agreement is created. Not an enum in the schema (AuditLog.eventType is a free-text column), but treated as one here so nothing else invents a competing string. */
export const AUDIT_EVENT_AGREEMENT_CREATED = "AGREEMENT_CREATED";

export interface AgreementTerms {
  sku: string;
  quantity: number;
  unitPrice: number;
  deliveryDays: number;
}

/** The public-safe shape of a persisted Agreement — no minPrice, no internal rule state, nothing merchant-private. */
export interface PersistedAgreement {
  id: string;
  sessionId: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  deliveryDays: number;
  totalAmount: number;
  status: string;
}

type AgreementRow = Prisma.AgreementModel & { catalogItem: { sku: string } };

function toPersistedAgreement(row: AgreementRow): PersistedAgreement {
  return {
    id: row.id,
    sessionId: row.sessionId,
    sku: row.catalogItem.sku,
    quantity: row.quantity,
    unitPrice: row.pricePerUnit,
    deliveryDays: row.deliveryDays,
    totalAmount: row.totalAmount,
    status: row.status,
  };
}

async function loadAgreementBySessionId(sessionId: string): Promise<AgreementRow | null> {
  return prisma.agreement.findUnique({
    where: { sessionId },
    include: { catalogItem: { select: { sku: true } } },
  });
}

/**
 * Creates the Agreement + its completion AuditLog for a session that has
 * just reached AGREED, or — if one already exists for this session —
 * returns that existing row instead. `created` tells the caller which
 * happened, purely informational (the response to the client is the
 * same shape either way).
 *
 * Idempotency is enforced by the database, not a client-side flag:
 * Agreement.sessionId is a unique column, so two concurrent calls for
 * the same session (e.g. the final turn retried or raced) can only ever
 * have one `agreement.create()` succeed — the other hits Prisma's
 * P2002 unique-constraint error and falls back to reading the row the
 * first call just created. The Agreement row and its AuditLog are
 * written in one transaction, so a caller can never observe one without
 * the other.
 *
 * Callers are responsible for only invoking this once a negotiation's
 * structured result is actually AGREED (see the turn API route) — this
 * function itself does not re-check negotiation state, only the
 * database's own constraint against duplicate rows for the same
 * session. `terms` must come from the deterministic negotiation result,
 * never parsed from an LLM message.
 */
export async function ensureAgreementForSession(
  sessionId: string,
  terms: AgreementTerms,
): Promise<{ agreement: PersistedAgreement; created: boolean }> {
  const catalogItem = await prisma.catalogItem.findUnique({
    where: { sku: terms.sku },
    select: { id: true },
  });
  if (!catalogItem) {
    throw new Error(`No catalog item found for SKU "${terms.sku}" while creating an agreement.`);
  }

  const totalAmount = terms.quantity * terms.unitPrice;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const agreement = await tx.agreement.create({
        data: {
          sessionId,
          catalogItemId: catalogItem.id,
          quantity: terms.quantity,
          pricePerUnit: terms.unitPrice,
          deliveryDays: terms.deliveryDays,
          totalAmount,
        },
        include: { catalogItem: { select: { sku: true } } },
      });

      // Business facts only — never minPrice or any other private
      // constraint. sessionId/agreementId already establish "which
      // negotiation" and "when" (createdAt); the payload just records
      // what was actually agreed.
      await tx.auditLog.create({
        data: {
          eventType: AUDIT_EVENT_AGREEMENT_CREATED,
          sessionId,
          agreementId: agreement.id,
          payload: JSON.stringify({
            sku: terms.sku,
            quantity: terms.quantity,
            unitPrice: terms.unitPrice,
            deliveryDays: terms.deliveryDays,
            totalAmount,
          }),
        },
      });

      return agreement;
    });

    return { agreement: toPersistedAgreement(created), created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await loadAgreementBySessionId(sessionId);
      if (existing) {
        return { agreement: toPersistedAgreement(existing), created: false };
      }
    }
    throw error;
  }
}

/** Looks up the Agreement for a session, if one exists. Used by GET /api/negotiations/:id/agreement and available for a future payment milestone. */
export async function getAgreementBySessionId(sessionId: string): Promise<PersistedAgreement | null> {
  const row = await loadAgreementBySessionId(sessionId);
  return row ? toPersistedAgreement(row) : null;
}
