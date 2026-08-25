// Bounded negotiation state machine — Phase 3, section 8.
//
// Deliberately separate from negotiationEngine.ts: this file owns only
// round-counting and status transitions, and knows nothing about prices,
// quantities, or catalog items. It is also separate from payment state
// (Agreement.status in the Prisma schema) — a negotiation finishing as
// AGREED is what allows an Agreement to be created later; it is not the
// Agreement itself.

export type NegotiationStatus =
  | "OPEN"
  | "COUNTERED"
  | "AGREED"
  | "REJECTED"
  | "EXPIRED";

export interface NegotiationState {
  status: NegotiationStatus;
  /** Number of merchant responses made so far. */
  round: number;
  maxRounds: number;
}

/** Default bound on negotiation rounds, per Phase 3 spec ("e.g. 4"). */
export const DEFAULT_MAX_ROUNDS = 4;

export function createNegotiationState(
  maxRounds: number = DEFAULT_MAX_ROUNDS,
): NegotiationState {
  return { status: "OPEN", round: 0, maxRounds };
}

const TERMINAL_STATUSES: NegotiationStatus[] = ["AGREED", "REJECTED", "EXPIRED"];

function isTerminal(state: NegotiationState): boolean {
  return TERMINAL_STATUSES.includes(state.status);
}

/**
 * Advances the state by one round given the outcome of evaluating the
 * latest request with the negotiation engine. Pure state transition —
 * does not itself run any fulfillment/pricing logic.
 *
 * - A terminal state (AGREED/REJECTED/EXPIRED) never changes: once a
 *   negotiation is closed, no further rounds are accepted.
 * - If all `maxRounds` rounds have already been used, the negotiation
 *   EXPIRES instead of allowing another round — this is what makes
 *   termination deterministic rather than open-ended.
 * - An engine outcome of REJECTED closes the negotiation immediately
 *   (a rejection doesn't need to consume a round to take effect).
 * - Any other outcome consumes one round and moves the negotiation to
 *   (or keeps it at) COUNTERED, awaiting an explicit accept/reject via
 *   acceptNegotiation/rejectNegotiation.
 */
export function advanceNegotiationState(
  state: NegotiationState,
  engineOutcome: "EXACT_MATCH" | "COUNTER_OFFER" | "PARTIAL_FULFILLMENT" | "REJECTED",
): NegotiationState {
  if (isTerminal(state)) {
    return state;
  }

  if (state.round >= state.maxRounds) {
    return { ...state, status: "EXPIRED" };
  }

  if (engineOutcome === "REJECTED") {
    return { ...state, status: "REJECTED" };
  }

  return { ...state, round: state.round + 1, status: "COUNTERED" };
}

/** Explicitly accepts the current terms on the table, closing the negotiation as AGREED. */
export function acceptNegotiation(state: NegotiationState): NegotiationState {
  if (isTerminal(state)) {
    return state;
  }
  return { ...state, status: "AGREED" };
}

/** Explicitly rejects the negotiation, closing it as REJECTED. */
export function rejectNegotiation(state: NegotiationState): NegotiationState {
  if (isTerminal(state)) {
    return state;
  }
  return { ...state, status: "REJECTED" };
}
