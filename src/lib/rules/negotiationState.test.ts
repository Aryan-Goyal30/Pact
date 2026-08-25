import { describe, expect, it } from "vitest";
import {
  acceptNegotiation,
  advanceNegotiationState,
  createNegotiationState,
  rejectNegotiation,
} from "./negotiationState";

describe("negotiation state machine", () => {
  it("starts OPEN at round 0", () => {
    const state = createNegotiationState(4);
    expect(state).toEqual({ status: "OPEN", round: 0, maxRounds: 4 });
  });

  it("moves to COUNTERED and increments round on a non-terminal outcome", () => {
    const state = advanceNegotiationState(createNegotiationState(4), "COUNTER_OFFER");
    expect(state.status).toBe("COUNTERED");
    expect(state.round).toBe(1);
  });

  it("closes as REJECTED immediately on a REJECTED engine outcome, without consuming a round", () => {
    const state = advanceNegotiationState(createNegotiationState(4), "REJECTED");
    expect(state.status).toBe("REJECTED");
    expect(state.round).toBe(0);
  });

  // 13. Maximum negotiation rounds.
  it("terminates deterministically as EXPIRED once the round limit is used up, instead of continuing forever", () => {
    let state = createNegotiationState(4);

    // Four rounds of ongoing back-and-forth (never REJECTED, never accepted).
    for (let i = 0; i < 4; i++) {
      state = advanceNegotiationState(state, "COUNTER_OFFER");
      expect(state.status).toBe("COUNTERED");
    }
    expect(state.round).toBe(4);

    // A fifth attempt has no rounds left — it must expire, not loop forever.
    state = advanceNegotiationState(state, "COUNTER_OFFER");
    expect(state.status).toBe("EXPIRED");

    // Once EXPIRED, further attempts are no-ops.
    const after = advanceNegotiationState(state, "EXACT_MATCH");
    expect(after).toEqual(state);
  });

  it("allows acceptNegotiation to close an open/countered negotiation as AGREED", () => {
    const countered = advanceNegotiationState(createNegotiationState(4), "COUNTER_OFFER");
    const agreed = acceptNegotiation(countered);
    expect(agreed.status).toBe("AGREED");
  });

  it("does not allow accept/reject to change a negotiation that already closed as AGREED", () => {
    const agreed = acceptNegotiation(createNegotiationState(4));
    expect(rejectNegotiation(agreed).status).toBe("AGREED");
    expect(acceptNegotiation(agreed).status).toBe("AGREED");
  });

  it("allows rejectNegotiation to close an open/countered negotiation as REJECTED", () => {
    const state = rejectNegotiation(createNegotiationState(4));
    expect(state.status).toBe("REJECTED");
  });
});
