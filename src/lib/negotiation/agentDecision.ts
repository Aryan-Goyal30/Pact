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
 * What a side read BEFORE deciding this round's move — the OBSERVE step
 * of the observe -> evaluate -> decide -> act loop the orchestrator
 * already runs every round, made an explicit, auditable value instead of
 * staying implicit across several function parameters. Every field here
 * is a direct, unmodified copy of a value buyerAgent.ts / merchantAgent.ts
 * already received as an input to build this same decision — nothing is
 * recomputed, and nothing here ever influences `move` / `candidates` /
 * `terms` below. Optional throughout: a field is present only when the
 * corresponding input was actually supplied/known this round (e.g. no
 * concessionContext means no round/roundsLeft to report, and the buyer's
 * opening round has no prior merchant offer to react to yet) — never
 * fabricated to fill a gap.
 */
export interface AgentObservation {
  /** 1-indexed round this decision was made in. Absent for a caller with no round context (e.g. the single-shot POST /api/negotiate). */
  round?: number;
  maxRounds?: number;
  /** Rounds remaining before the round budget is exhausted, floored at 1 — the same trivial "how many rounds are left" arithmetic every round-aware concession formula in this codebase already derives inline (buyerRules.ts / negotiationEngine.ts); echoed here for display only, never a second implementation of any strategic decision. */
  roundsLeft?: number;
  /**
   * The requirement this side is negotiating against this round: the
   * buyer's own original constraints for the buyer's own observation; the
   * buyer's CURRENT stated ask (quantity/price/delivery) for the
   * merchant's observation, since that request is the entirety of what
   * the merchant ever observes of "the buyer's requirement" — it never
   * sees the buyer's true underlying ceiling, exactly like every other
   * merchant-facing value in this codebase.
   */
  buyerRequirement: {
    quantity: number;
    /** Undefined only when the buyer genuinely stated no price ceiling (see NegotiationRequest.maxUnitPrice) — never fabricated. */
    maxUnitPrice?: number;
    /** Undefined only when the buyer genuinely stated no delivery deadline (see NegotiationRequest.deliveryDeadlineDays) — never fabricated. */
    deliveryDeadlineDays?: number;
  };
  /**
   * The merchant's most recent public offer this round is reacting to —
   * buyer-side only (see buyerAgent.ts). Undefined on the buyer's opening
   * round, before any merchant offer exists yet to observe. There is no
   * merchant-side equivalent field: the merchant's own "what it's
   * reacting to" is already fully captured by `buyerRequirement` above.
   */
  previousMerchantOffer?: { quantity: number | null; unitPrice: number | null; deliveryDays: number | null };
  /**
   * This side's own live leverage reading at decision time (leverage.ts).
   * The buyer only ever receives its own aggregate score (merchant
   * omitted here too) — merchantAgent.ts receives both — mirroring the
   * exact visibility boundary each agent already has today; never widened
   * by this field.
   */
  leverage?: { buyer?: number; merchant?: number };
}

/**
 * One side's (buyer or merchant) deterministic decision for a single
 * round. Every field is a direct capture of something already computed
 * elsewhere — nothing here is derived or inferred by this module itself.
 */
export interface AgentDecisionRecord {
  side: "buyer" | "merchant";
  /** What this side observed before deciding — see AgentObservation. */
  observation: AgentObservation;
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
