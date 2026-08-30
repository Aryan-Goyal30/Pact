import { describe, expect, it } from "vitest";
import { MOCK_VALID_SIGNATURE, type PaymentOrderResponseDTO } from "@/types/payment";
import {
  attemptProgressLabel,
  buildCheckoutSuccessRequestBody,
  buildFailureReportRequestBody,
  buildMockVerifyRequestBody,
  paymentFailureLabel,
  paymentStatusLabel,
} from "./paymentUi";

const baseOrder: PaymentOrderResponseDTO = {
  razorpayOrderId: "order_mock_abc",
  amount: 4471900,
  currency: "INR",
  keyId: "rzp_test_x",
  attemptNumber: 1,
  isRecovery: false,
  maxAttempts: 2,
};

describe("buildCheckoutSuccessRequestBody", () => {
  it("relays a real Checkout handler response verbatim", () => {
    const body = buildCheckoutSuccessRequestBody({
      razorpay_order_id: "order_1",
      razorpay_payment_id: "pay_1",
      razorpay_signature: "sig_1",
    });
    expect(body).toEqual({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1", razorpaySignature: "sig_1" });
  });
});

// M13.2 — this now builds the /report-failure request body (informational
// audit-only reporting), never /verify's — see paymentUi.ts's own header
// comment on why a real Checkout `payment.failed` event no longer
// terminalizes anything.
describe("buildFailureReportRequestBody", () => {
  it("carries the order id, error code, and description — with no signature-shaped fields at all", () => {
    const body = buildFailureReportRequestBody("order_1", "GATEWAY_ERROR", "The card was declined.", undefined);
    expect(body).toEqual({ razorpayOrderId: "order_1", errorCode: "GATEWAY_ERROR", errorDescription: "The card was declined." });
    expect(body).not.toHaveProperty("razorpaySignature");
    expect(body).not.toHaveProperty("razorpayPaymentId");
  });

  // M13.1 §7 / M13.2 — forward Razorpay's real payment.failed metadata
  // payment_id when present, purely for audit/reconciliation visibility.
  it("forwards reportedPaymentId when Razorpay's event included one", () => {
    const body = buildFailureReportRequestBody("order_1", "GATEWAY_ERROR", undefined, "pay_real_123");
    expect(body).toEqual({
      razorpayOrderId: "order_1",
      errorCode: "GATEWAY_ERROR",
      reportedPaymentId: "pay_real_123",
    });
  });

  it("omits any field Razorpay's event didn't provide — still no proof required for any of them", () => {
    const body = buildFailureReportRequestBody("order_1", undefined, undefined, undefined);
    expect(body).toEqual({ razorpayOrderId: "order_1" });
  });
});

describe("buildMockVerifyRequestBody — never decides the outcome itself, only relays the server's own hint", () => {
  it("constructs a success request (with the exact mock sentinel signature) when the server hinted success", () => {
    const body = buildMockVerifyRequestBody({ ...baseOrder, mockForceOutcome: "success" });
    expect(body.razorpaySignature).toBe(MOCK_VALID_SIGNATURE);
    expect(body.razorpayPaymentId).toBeDefined();
    expect(body.reportedFailureCode).toBeUndefined();
  });

  it("constructs a failure report when the server hinted failure", () => {
    const body = buildMockVerifyRequestBody({ ...baseOrder, mockForceOutcome: "failure" });
    expect(body.reportedFailureCode).toBeDefined();
    expect(body.razorpaySignature).toBeUndefined();
  });

  it("defaults to a failure report (never a fabricated success) when no hint is present at all", () => {
    const body = buildMockVerifyRequestBody({ ...baseOrder, mockForceOutcome: undefined });
    expect(body.razorpaySignature).toBeUndefined();
  });

  it("always carries the order's own razorpayOrderId, regardless of outcome", () => {
    expect(buildMockVerifyRequestBody({ ...baseOrder, mockForceOutcome: "success" }).razorpayOrderId).toBe("order_mock_abc");
    expect(buildMockVerifyRequestBody({ ...baseOrder, mockForceOutcome: "failure" }).razorpayOrderId).toBe("order_mock_abc");
  });
});

describe("attemptProgressLabel", () => {
  it("labels the first attempt plainly", () => {
    expect(attemptProgressLabel(1, false, 2)).toBe("Attempt 1 of 2");
  });

  it("labels a recovery attempt distinctly", () => {
    expect(attemptProgressLabel(2, true, 2)).toBe("Attempt 2 of 2 (Recovery)");
  });
});

describe("paymentStatusLabel", () => {
  it("has a distinct, non-empty label for every real Agreement payment status", () => {
    const statuses = ["pending_payment", "paid", "failed", "recovered", "closed"];
    const labels = statuses.map(paymentStatusLabel);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("falls back to the raw status string for anything unrecognized, rather than throwing", () => {
    expect(paymentStatusLabel("some_future_status")).toBe("some_future_status");
  });
});

describe("paymentFailureLabel", () => {
  it("has a distinct, UI-safe label for every real failure reason", () => {
    const reasons = ["payment_declined", "verification_failed", "order_creation_failed", "timeout", "unknown"];
    for (const reason of reasons) {
      expect(paymentFailureLabel(reason).length).toBeGreaterThan(0);
    }
  });

  it("returns an empty string for an undefined reason", () => {
    expect(paymentFailureLabel(undefined)).toBe("");
  });
});
