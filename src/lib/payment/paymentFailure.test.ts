import { describe, expect, it } from "vitest";
import {
  classifyCheckoutFailure,
  describePaymentFailure,
  PAYMENT_FAILURE_REASONS,
  type PaymentFailureReason,
} from "./paymentFailure";

describe("PAYMENT_FAILURE_REASONS", () => {
  it("is a small, closed vocabulary — exactly the 5 named reasons, never more", () => {
    expect(PAYMENT_FAILURE_REASONS).toEqual([
      "payment_declined",
      "verification_failed",
      "order_creation_failed",
      "timeout",
      "unknown",
    ]);
  });
});

describe("describePaymentFailure", () => {
  it("has a distinct, non-empty, UI-safe label for every reason", () => {
    const labels = PAYMENT_FAILURE_REASONS.map(describePaymentFailure);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }
    expect(new Set(labels).size).toBe(labels.length); // all distinct
  });

  it("never echoes a raw provider-style code back into the label", () => {
    for (const reason of PAYMENT_FAILURE_REASONS) {
      const label = describePaymentFailure(reason);
      expect(label).not.toMatch(/BAD_REQUEST_ERROR|GATEWAY_ERROR|RESOURCE_EXHAUSTED/);
    }
  });
});

describe("classifyCheckoutFailure", () => {
  it("classifies a gateway/bank/card code as payment_declined", () => {
    expect(classifyCheckoutFailure("GATEWAY_ERROR")).toBe<PaymentFailureReason>("payment_declined");
    expect(classifyCheckoutFailure("BANK_ERROR")).toBe<PaymentFailureReason>("payment_declined");
    expect(classifyCheckoutFailure("CARD_DECLINED")).toBe<PaymentFailureReason>("payment_declined");
  });

  it("classifies a timeout code as timeout", () => {
    expect(classifyCheckoutFailure("GATEWAY_TIMEOUT_ERROR")).toBe<PaymentFailureReason>("timeout");
  });

  it("classifies an unrecognized code as unknown", () => {
    expect(classifyCheckoutFailure("SOME_NEW_RAZORPAY_CODE")).toBe<PaymentFailureReason>("unknown");
  });

  it("classifies a missing code as unknown", () => {
    expect(classifyCheckoutFailure(undefined)).toBe<PaymentFailureReason>("unknown");
    expect(classifyCheckoutFailure(null)).toBe<PaymentFailureReason>("unknown");
    expect(classifyCheckoutFailure("")).toBe<PaymentFailureReason>("unknown");
  });

  it("is case-insensitive", () => {
    expect(classifyCheckoutFailure("gateway_error")).toBe<PaymentFailureReason>("payment_declined");
  });
});
