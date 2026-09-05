// Tests for the defensive LLM-message validation layer — the fix for
// the observed bug where Gemini occasionally truncated/invented numbers
// ("45,37" instead of "45,375", "10" instead of "100") or emitted
// garbled text ("*** a Sentence"). checkAgentMessageIntegrity is the
// single gate buyerAgent.ts / merchantAgent.ts run every LLM-generated
// message through before displaying it.

import { describe, expect, it } from "vitest";
import { checkAgentMessageIntegrity } from "./messageIntegrity";

const context = {
  authoritativeFacts: {
    side: "MERCHANT",
    action: "COUNTER_OFFER",
    sku: "LAPTOP-14-I5",
    quantity: 100,
    unitPrice: 45375,
    deliveryDays: 5,
  },
};

describe("checkAgentMessageIntegrity", () => {
  it("accepts a message that states every required value exactly", () => {
    const result = checkAgentMessageIntegrity(
      "We can supply 100 units at ₹45,375 per unit, with delivery in 5 days.",
      [100, 45375, 5],
      context,
    );
    expect(result.valid).toBe(true);
  });

  // Quantity 100 truncated/replaced with 10.
  it("rejects a message where quantity 100 was replaced with 10", () => {
    const result = checkAgentMessageIntegrity(
      "We can supply 10 units at ₹45,375 per unit, with delivery in 5 days.",
      [100, 45375, 5],
      context,
    );
    expect(result.valid).toBe(false);
  });

  // Price ₹45,375 truncated to ₹45,37 — the exact observed bug.
  it("rejects a message where the price was truncated from 45,375 to 45,37", () => {
    const result = checkAgentMessageIntegrity(
      "Your price of 45,37 has been noted.",
      [100, 45375, 5],
      context,
    );
    expect(result.valid).toBe(false);
  });

  it("rejects a message missing the delivery days entirely", () => {
    const result = checkAgentMessageIntegrity(
      "We can supply 100 units at ₹45,375 per unit.",
      [100, 45375, 5],
      context,
    );
    expect(result.valid).toBe(false);
  });

  it("rejects a message that invents a number absent from the context", () => {
    const result = checkAgentMessageIntegrity(
      "We can offer 99999 units at ₹1 each, delivered tomorrow.",
      [],
      context,
    );
    expect(result.valid).toBe(false);
  });

  it("rejects garbled/nonsense output", () => {
    expect(checkAgentMessageIntegrity("*** a Sentence", [], context).valid).toBe(false);
    expect(checkAgentMessageIntegrity("", [], context).valid).toBe(false);
    expect(checkAgentMessageIntegrity("ok", [], context).valid).toBe(false);
  });

  it("accepts a plain reject message with no required numbers", () => {
    const result = checkAgentMessageIntegrity(
      "We're unable to fulfill this request.",
      [],
      context,
    );
    expect(result.valid).toBe(true);
  });

  it("allows a number that appears elsewhere in the context but isn't required (e.g. the buyer's own budget)", () => {
    const widerContext = {
      ...context,
      buyerConstraints: { maxUnitPrice: 45000 },
    };
    const result = checkAgentMessageIntegrity(
      "We can supply 100 units at ₹45,375 per unit, with delivery in 5 days — above your budget of 45000.",
      [100, 45375, 5],
      widerContext,
    );
    expect(result.valid).toBe(true);
  });

  it("null/undefined entries in requiredNumbers are ignored", () => {
    const result = checkAgentMessageIntegrity(
      "We're unable to fulfill this request.",
      [null, undefined, null],
      context,
    );
    expect(result.valid).toBe(true);
  });
});
