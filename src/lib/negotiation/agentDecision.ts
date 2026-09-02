// Agentic Decision + Audit Trail — first layer.
//
// Purely additive, OBSERVABILITY-only: every field here is captured from
// values the deterministic engine + agents ALREADY computed before this
// module ever runs (buyerAgent.ts / merchantAgent.ts / leverage.ts) —
// nothing here decides, recomputes, or influences a single negotiated
// number, and nothing here is ever shown to or read by the LLM. This is
// strictly a snapshot of decisions already made by plain, deterministic
// code, taken AFTER the fact for display/audit purposes.
//
// - buyerAgent.ts / merchantAgent.ts each build their own AgentDecisionRecord
//   (see BuyerAgentResponse.agentDecision / MerchantAgentResponse.agentDecision)
//   — each side owns describing its own decision, exactly like it already
//   owns move/tradeMove/sufficiency.
// - orchestrator.ts lifts both sides' records, plus this round's leverage
//   snapshot, into one TurnDecisionAudit per turn (NegotiationTurnResult.decisionAudit).
// - negotiationSessionRepository.ts persists that snapshot into the
//   EXISTING AuditLog table (no schema migration — see
//   AUDIT_EVENT_NEGOTIATION_DECISION there).
// - types/negotiation.ts exposes the same shape to the browser as an
//   additive optional field on NegotiationTurnResponse.

import type { CandidateMove, CandidateMoveType } from "@/lib/rules/candidateMove";

export interface AgentDecisionSufficiency {
  verdict: string;
  shortfallFraction: number;
  reason: string;
}

/**
 * One side's (buyer or merchant) deterministic decision for a single
 * round. Every field is a direct capture of something already computed
 * elsewhere — nothing here is derived or inferred by this module itself.
 */
export interface AgentDecisionRecord {
  side: "buyer" | "merchant";
  /**
   * The winning strategic move (HOLD / CONCEDE / a trade), when a
   * genuine candidate-selection decision was made this round — see
   * buyerMoveSelection.ts / merchantMoveSelection.ts. Absent when no
   * such decision applies this round (the opening request, a plain
   * accept/reject, or a caller without a round context) — the exact same
   * set of cases the existing `move`/`tradeMove` fields are already
   * null/undefined for.
   */
  move?: CandidateMoveType;
  /**
   * Deterministic, engine-computed reasons behind this round's outcome
   * — e.g. the winning candidate's own rationale (stock pressure,
   * reciprocity, a trade's own justification). Sourced from
   * NegotiationResult.reasons (merchant) or the winning candidate's own
   * `reason` (buyer) — never authored or altered by the LLM.
   */
  deterministicReasons: string[];
  /**
   * Broader strategic factors that shaped this round (urgency, quantity
   * leverage, remaining rounds) — see negotiationStrategy.explainBuyerFactors.
   * Buyer-side only today (merchant has no equivalent standalone
   * factor list distinct from its own deterministic reasons); empty
   * otherwise. Deliberately captured separately from
   * `deterministicReasons`, even though today's LLM-prompt-facing
   * `strategicReasons` field (buyerAgent.ts) folds the two together for
   * a different purpose — this field is NOT that one, and changing
   * neither affects the other.
   */
  strategicReasons: string[];
  /** Buyer-only: whether the offered quantity was judged sufficient this round — see buyerQuantitySufficiency.ts. Omitted when never evaluated. */
  sufficiency?: AgentDecisionSufficiency;
  /**
   * Every candidate move genuinely considered this round, not just the
   * winner — see candidateMove.ts. Omitted when no candidate comparison
   * happened this round (opening request, plain accept/reject, no round
   * context, or the offer was accepted outright before candidates were
   * ever generated).
   */
  candidates?: CandidateMove[];
  /** The resulting terms this decision produced. */
  terms: { quantity: number | null; unitPrice: number | null; deliveryDays: number | null };
}

/**
 * The full decision audit for one turn — both sides' decisions plus the
 * live leverage snapshot they were made against. `merchant` is absent
 * when no merchant agent call happened this round (the buyer accepted or
 * rejected the merchant's PRIOR offer without a fresh merchant turn, or
 * a structural walk-away closed the negotiation before either agent ran
 * this round) — never fabricated to fill the gap.
 */
export interface TurnDecisionAudit {
  buyer: AgentDecisionRecord;
  merchant?: AgentDecisionRecord;
  leverage: { buyer: number; merchant: number; reasons: string[] };
}
