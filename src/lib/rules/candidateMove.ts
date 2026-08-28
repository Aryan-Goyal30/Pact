// The smallest useful internal candidate-move representation — PACT V2
// Milestone 9.
//
// Not a TradeProposal framework, not a class hierarchy, not a database
// model — a single flat interface that lets buyerMoveSelection.ts and
// merchantMoveSelection.ts each ADAPT their existing, unchanged decision
// functions' outputs into one common shape for comparison. Every
// existing decision module (buyerQuantityTrade.ts, buyerDeliveryTrade.ts,
// buyerMoveSelector.ts, merchantTradeEvaluator.ts,
// merchantDeliveryTradeEvaluator.ts) already computes something shaped
// almost exactly like this — the only thing missing was a common name
// for it and a place to compare several at once.
//
// Deliberately generic across quantity/delivery so a future package
// candidate (multiple terms changed at once) is just another value of
// this same type — quantity/deliveryDays are already optional, exactly
// what a partial package needs — without requiring any redesign of this
// interface. Not implemented in this milestone; see the Milestone 8
// design review for why.

export type CandidateMoveType = "HOLD" | "CONCEDE" | "QUANTITY_FOR_PRICE" | "DELIVERY_FOR_PRICE";

export interface CandidateMove {
  move: CandidateMoveType;
  /** Always present — every candidate, from every dimension, ultimately proposes a price. */
  unitPrice: number;
  /** Only set when this candidate changes quantity (QUANTITY_FOR_PRICE). Absent otherwise — the caller falls back to the round's existing quantity. */
  quantity?: number;
  /** Only set when this candidate changes delivery (DELIVERY_FOR_PRICE). Absent otherwise — the caller falls back to the round's existing delivery days. */
  deliveryDays?: number;
  /** Human-readable explanation, taken directly from whichever existing decision function produced this candidate — never invented here. */
  reason: string;
}
