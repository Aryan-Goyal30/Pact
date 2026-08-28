// Shared structured negotiation message — Phase 5A, Part 4.
//
// Both agents' natural-language output rides alongside these structured
// fields, but the fields are what's authoritative: nothing in the
// system ever parses `message` to recover a price, quantity, or
// delivery day — those always come from the deterministic engine
// (negotiationEngine.ts) or the buyer's own constraints (buyerRules.ts).
//
// This shape deliberately mirrors the NegotiationMessage table already
// defined in prisma/schema.prisma (sender / type / sku / quantity /
// pricePerUnit / deliveryDays / messageText), so a later phase that
// persists a transcript can map to it directly instead of inventing a
// second representation of the same concept.
//
// Milestone 10: `move` is additive observability for a strategic decision
// that was ALREADY made deterministically before this message was ever
// built (see buyerMoveSelection.ts / merchantMoveSelection.ts) — it never
// changes `type` or any negotiated term, and the LLM never sees or
// chooses it. Reuses CandidateMoveType directly rather than inventing a
// second, incompatible move enum.

import type { CandidateMoveType } from "@/lib/rules/candidateMove";

export type NegotiationParticipant = "buyer" | "merchant";

export type NegotiationMessageType =
  | "request"
  | "offer"
  | "counter_offer"
  | "accept"
  | "reject";

export interface StructuredNegotiationMessage {
  sender: NegotiationParticipant;
  type: NegotiationMessageType;
  sku: string;
  /** null when the message carries no concrete terms (e.g. an outright reject). */
  quantity: number | null;
  unitPrice: number | null;
  deliveryDays: number | null;
  /** LLM-generated text for display only — never parsed for its content. */
  message: string;
  /**
   * Milestone 10: the deterministic strategic move that produced this
   * message, when one was genuinely decided by the candidate-selection
   * layer this round. Absent (not null) whenever no such decision was
   * made for this message — the opening request, an ordinary accept, an
   * ordinary reject, or a walk-away — matching exactly the set of cases
   * BuyerAgentResponse.move/tradeMove and MerchantAgentResponse.move are
   * already null/undefined for. Never set by, read from, or inferred by
   * the LLM.
   */
  move?: CandidateMoveType;
}
