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
}
