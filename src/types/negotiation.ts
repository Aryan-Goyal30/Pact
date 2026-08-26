// Public shape of POST /api/negotiations — the browser-safe view of a
// full negotiation run. Every field here is safe to send to the
// browser. Nothing derived from CatalogItem.minPrice may ever appear on
// these types — see src/lib/negotiation/negotiationRunResponse.ts for
// the DTO construction that enforces this at runtime, the same pattern
// src/lib/manifest.ts uses for the public manifest.

import type {
  NegotiationMessageType,
  NegotiationParticipant,
} from "@/lib/negotiation/protocol";
import type { NegotiationStatus } from "@/lib/rules/negotiationState";

/** The buyer request a client submits to start a negotiation run. */
export interface NegotiationRunRequest {
  sku: string;
  quantity: number;
  maxUnitPrice: number;
  deliveryDeadlineDays: number;
}

export interface NegotiationMessageDTO {
  sender: NegotiationParticipant;
  type: NegotiationMessageType;
  sku: string;
  quantity: number | null;
  unitPrice: number | null;
  deliveryDays: number | null;
  message: string;
}

export interface NegotiationTurnDTO {
  /** 1-indexed turn number, for display. */
  turn: number;
  buyer: NegotiationMessageDTO;
  merchant: NegotiationMessageDTO;
  status: NegotiationStatus;
}

export interface NegotiationAgreementDTO {
  sku: string;
  quantity: number;
  unitPrice: number;
  deliveryDays: number;
  totalAmount: number;
}

export interface NegotiationRunResponse {
  sku: string;
  finalStatus: NegotiationStatus;
  rounds: number;
  maxRounds: number;
  transcript: NegotiationTurnDTO[];
  /** Present only when finalStatus is "AGREED". */
  agreement: NegotiationAgreementDTO | null;
}

// ---------------------------------------------------------------------------
// Turn-based flow (Phase 5B) — POST /api/negotiations (create a session)
// and POST /api/negotiations/:id/turn (advance it by exactly one turn).
// ---------------------------------------------------------------------------

/** Body for POST /api/negotiations. */
export interface NegotiationSessionCreateRequest {
  sku: string;
  quantity: number;
  maxUnitPrice: number;
  deliveryDeadlineDays: number;
  /** Optional override of the default round bound. */
  maxRounds?: number;
}

export interface NegotiationSessionResponse {
  sessionId: string;
  sku: string;
  status: NegotiationStatus;
  round: number;
  maxRounds: number;
  buyerConstraints: {
    quantity: number;
    maxUnitPrice: number;
    deliveryDeadlineDays: number;
  };
}

/**
 * The persisted Agreement's public-safe fields — includes the row id
 * and status on top of NegotiationAgreementDTO's structural terms, since
 * this reflects a real, durable database record a future payment
 * milestone can look up (see agreementRepository.ts). Never carries
 * minPrice, any other private merchant constraint, or anything derived
 * from the LLM's natural-language message.
 */
export interface PersistedAgreementDTO {
  id: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  deliveryDays: number;
  totalAmount: number;
  /** "pending_payment" | "paid" | "failed" | "recovered" | "closed" */
  status: string;
}

/** Response for POST /api/negotiations/:id/turn. */
export interface NegotiationTurnResponse {
  sessionId: string;
  turn: number;
  buyer: NegotiationMessageDTO;
  merchant: NegotiationMessageDTO;
  status: NegotiationStatus;
  round: number;
  maxRounds: number;
  /** Present only when this turn just closed the negotiation as AGREED — the real persisted Agreement, not a structural preview. */
  agreement: PersistedAgreementDTO | null;
}
