// Builds the browser-safe DTO for a completed negotiation run.
//
// Pure and DB/LLM-free: takes exactly what runNegotiationToCompletion
// (orchestrator.ts) returns and explicitly whitelists fields onto
// NegotiationRunResponse, the same "construct, don't spread" pattern
// src/lib/manifest.ts uses for the public manifest. NegotiationTurnResult
// and StructuredNegotiationMessage never carry minPrice in the first
// place (see negotiationEngine.ts / negotiation/protocol.ts), so there
// is nothing private to filter out — but building an explicit DTO here
// still means a future field added to those internal types can't
// silently start reaching the browser without a deliberate edit to this
// mapping.

import type { NegotiationTurnResult } from "@/lib/negotiation/orchestrator";
import type { StructuredNegotiationMessage } from "@/lib/negotiation/protocol";
import type { NegotiationState } from "@/lib/rules/negotiationState";
import type {
  NegotiationAgreementDTO,
  NegotiationMessageDTO,
  NegotiationRunResponse,
  NegotiationTurnDTO,
} from "@/types/negotiation";

/** Exported for reuse by the turn-based response builder (negotiationTurnResponse.ts). */
export function toMessageDTO(message: StructuredNegotiationMessage): NegotiationMessageDTO {
  return {
    sender: message.sender,
    type: message.type,
    sku: message.sku,
    quantity: message.quantity,
    unitPrice: message.unitPrice,
    deliveryDays: message.deliveryDays,
    message: message.message,
    // Milestone 10: additive observability field — carried through
    // unchanged, never recomputed. Undefined here (the common case for
    // request/accept/reject messages) is dropped entirely by
    // JSON.stringify at the API boundary, so old consumers see no new key.
    move: message.move,
  };
}

/** Exported for reuse by the turn-based response builder (negotiationTurnResponse.ts). */
export function toAgreement(
  sku: string,
  status: NegotiationState["status"],
  closingTurn: NegotiationTurnResult | undefined,
): NegotiationAgreementDTO | null {
  if (status !== "AGREED" || !closingTurn) {
    return null;
  }

  const { quantity, unitPrice, deliveryDays } = closingTurn.merchant;
  if (quantity === null || unitPrice === null || deliveryDays === null) {
    return null;
  }

  return {
    sku,
    quantity,
    unitPrice,
    deliveryDays,
    totalAmount: quantity * unitPrice,
  };
}

export function buildNegotiationRunResponse(
  sku: string,
  transcript: NegotiationTurnResult[],
  finalState: NegotiationState,
): NegotiationRunResponse {
  const turns: NegotiationTurnDTO[] = transcript.map((turn, index) => ({
    turn: index + 1,
    buyer: toMessageDTO(turn.buyer),
    merchant: toMessageDTO(turn.merchant),
    status: turn.state.status,
  }));

  return {
    sku,
    finalStatus: finalState.status,
    rounds: finalState.round,
    maxRounds: finalState.maxRounds,
    transcript: turns,
    agreement: toAgreement(sku, finalState.status, transcript[transcript.length - 1]),
  };
}
