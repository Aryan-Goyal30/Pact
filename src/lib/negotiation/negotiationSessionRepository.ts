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
import type {
  NegotiationMessageType,
  NegotiationParticipant,
} from "@/lib/negotiation/protocol";
import type { NegotiationMessageDTO } from "@/types/negotiation";

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

export interface LoadedTurnMessages {
  turnNumber: number;
  buyer: NegotiationMessageDTO;
  merchant: NegotiationMessageDTO;
}

/**
 * Re-reads the most recently persisted turn's buyer/merchant messages
 * without running a new negotiation turn — used to replay the response
 * of an already-terminal session (e.g. a repeated POST .../turn after
 * AGREED) purely from what's already on disk. Returns null if the
 * session has no messages yet.
 */
export async function loadLatestTurn(
  sessionId: string,
  sku: string,
): Promise<LoadedTurnMessages | null> {
  const latest = await prisma.negotiationMessage.findFirst({
    where: { sessionId },
    orderBy: { round: "desc" },
  });
  if (!latest) {
    return null;
  }

  const rows = await prisma.negotiationMessage.findMany({
    where: { sessionId, round: latest.round },
  });
  const buyerRow = rows.find((row) => row.sender === "buyer");
  const merchantRow = rows.find((row) => row.sender === "merchant");
  if (!buyerRow || !merchantRow) {
    return null;
  }

  const toDTO = (row: typeof buyerRow): NegotiationMessageDTO => ({
    sender: row.sender as NegotiationParticipant,
    type: row.type as NegotiationMessageType,
    sku,
    quantity: row.quantity,
    unitPrice: row.pricePerUnit,
    deliveryDays: row.deliveryDays,
    message: row.messageText,
  });

  return { turnNumber: latest.round, buyer: toDTO(buyerRow), merchant: toDTO(merchantRow) };
}

/**
 * Milestone 3: the merchant's unit price from the round BEFORE the
 * given one — lets the buyer's move selector (buyerMoveSelector.ts)
 * detect whether the merchant's most recent offer was genuine forward
 * progress. Reuses the existing NegotiationMessage history (no schema
 * change); returns null if that earlier round doesn't exist (e.g. the
 * buyer's first real counter, where there is only one merchant offer
 * on record so far).
 */
export async function loadMerchantUnitPriceAtRound(
  sessionId: string,
  round: number,
): Promise<number | null> {
  if (round < 1) {
    return null;
  }
  const row = await prisma.negotiationMessage.findFirst({
    where: { sessionId, sender: "merchant", round },
  });
  return row?.pricePerUnit ?? null;
}

/**
 * Milestone 5: whether the buyer has EVER proposed a quantity greater
 * than its original requested quantity anywhere in this session's
 * history — i.e. whether the quantity-for-price bargaining chip
 * (buyerQuantityTrade.ts) has already been used. Deliberately scans the
 * WHOLE history rather than only the most recent round: a single-round
 * lookback could "forget" a trade used earlier if the buyer's mirrored
 * quantity later drops back down (e.g. a subsequent partial-fulfillment
 * offer), which would wrongly let the chip fire again. No schema
 * change — reuses the existing NegotiationMessage.quantity column,
 * same pattern as loadMerchantUnitPriceAtRound above.
 */
export async function hasBuyerProposedQuantityAbove(
  sessionId: string,
  originalQuantity: number,
): Promise<boolean> {
  const row = await prisma.negotiationMessage.findFirst({
    where: { sessionId, sender: "buyer", quantity: { gt: originalQuantity } },
  });
  return row !== null;
}
