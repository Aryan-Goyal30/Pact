// Persistence for turn-based negotiation sessions — Phase 5B.
//
// The only DB-touching module in the negotiation stack (mirrors
// catalogRepository.ts's role for the rule engine). Reuses the
// NegotiationSession / NegotiationMessage tables Phase 1 already
// defined for exactly this purpose — no new tables, just three
// additional columns on NegotiationSession (sku, maxRounds,
// pendingMerchantResultRaw) to make a session round-trippable through
// HTTP requests. See prisma/schema.prisma for why each one exists.

import { prisma } from "@/lib/prisma";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import type { NegotiationResult } from "@/lib/rules/negotiationEngine";
import type { NegotiationState, NegotiationStatus } from "@/lib/rules/negotiationState";
import type { NegotiationTurnResult } from "@/lib/negotiation/orchestrator";

/** Creates a new OPEN session and returns its id. Executes no turns. */
export async function createNegotiationSession(
  sku: string,
  buyerConstraints: BuyerConstraints,
  maxRounds: number,
): Promise<{ id: string }> {
  const session = await prisma.negotiationSession.create({
    data: {
      sku,
      status: "OPEN",
      buyerRequestRaw: JSON.stringify(buyerConstraints),
      roundCount: 0,
      maxRounds,
    },
  });
  return { id: session.id };
}

export interface LoadedNegotiationSession {
  id: string;
  sku: string;
  buyerConstraints: BuyerConstraints;
  state: NegotiationState;
  /** Feed directly into runNegotiationTurn's `previousMerchantResult`. */
  previousMerchantResult: NegotiationResult | null;
}

/** Loads a session and reconstructs exactly the shape runNegotiationTurn needs to continue it. Returns null if the id doesn't exist. */
export async function loadNegotiationSession(
  id: string,
): Promise<LoadedNegotiationSession | null> {
  const session = await prisma.negotiationSession.findUnique({ where: { id } });
  if (!session) {
    return null;
  }

  return {
    id: session.id,
    sku: session.sku,
    buyerConstraints: JSON.parse(session.buyerRequestRaw) as BuyerConstraints,
    state: {
      status: session.status as NegotiationStatus,
      round: session.roundCount,
      maxRounds: session.maxRounds,
    },
    previousMerchantResult: session.pendingMerchantResultRaw
      ? (JSON.parse(session.pendingMerchantResultRaw) as NegotiationResult)
      : null,
  };
}

/**
 * Persists exactly one completed turn: the buyer + merchant
 * NegotiationMessage rows, and the session's updated status/round/
 * pending-offer bookkeeping — in one transaction, so a session can
 * never be left with messages but a stale status or vice versa.
 * Returns the 1-indexed turn number the caller should show the user.
 */
export async function persistNegotiationTurn(
  sessionId: string,
  turn: NegotiationTurnResult,
): Promise<{ turnNumber: number }> {
  const existingTurns = await prisma.negotiationMessage.count({
    where: { sessionId, sender: "buyer" },
  });
  const turnNumber = existingTurns + 1;

  await prisma.$transaction([
    prisma.negotiationMessage.create({
      data: {
        sessionId,
        sender: "buyer",
        type: turn.buyer.type,
        quantity: turn.buyer.quantity,
        pricePerUnit: turn.buyer.unitPrice,
        deliveryDays: turn.buyer.deliveryDays,
        messageText: turn.buyer.message,
        round: turnNumber,
      },
    }),
    prisma.negotiationMessage.create({
      data: {
        sessionId,
        sender: "merchant",
        type: turn.merchant.type,
        quantity: turn.merchant.quantity,
        pricePerUnit: turn.merchant.unitPrice,
        deliveryDays: turn.merchant.deliveryDays,
        messageText: turn.merchant.message,
        round: turnNumber,
      },
    }),
    prisma.negotiationSession.update({
      where: { id: sessionId },
      data: {
        status: turn.state.status,
        roundCount: turn.state.round,
        pendingMerchantResultRaw: turn.nextMerchantResult
          ? JSON.stringify(turn.nextMerchantResult)
          : null,
      },
    }),
  ]);

  return { turnNumber };
}
