import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  generateMockOrderId,
  getPaymentProvider,
  isMockProviderActive,
  realRazorpayProvider,
  rupeesToPaise,
  verifyWebhookSignature,
} from "./razorpayClient";
import { mockRazorpayProvider } from "./mockRazorpayAdapter";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("rupeesToPaise — the ONE named rupees->paise helper", () => {
  it("multiplies by 100 and rounds to the nearest integer paisa", () => {
    expect(rupeesToPaise(45844)).toBe(4584400);
    expect(rupeesToPaise(1)).toBe(100);
    expect(rupeesToPaise(0)).toBe(0);
  });

  it("rounds a fractional rupee amount to the nearest paisa rather than truncating or leaving a fraction", () => {
    // 45844.545 rupees * 100 = 4584454.5 paise -> rounds to 4584455 (banker's-free Math.round, ties away from zero).
    expect(rupeesToPaise(45844.545)).toBe(4584455);
    // A value that would otherwise land a hair below an integer due to
    // floating-point drift (0.1 + 0.2 style error) still rounds cleanly.
    expect(rupeesToPaise(45844.1 + 0.2)).toBe(4584430);
  });

  it("never returns a non-integer", () => {
    for (const rupees of [45844, 100.005, 999.999, 0.01]) {
      expect(Number.isInteger(rupeesToPaise(rupees))).toBe(true);
    }
  });

  it("the worked example from the milestone spec: ₹45,844 -> 4,584,400 paise", () => {
    expect(rupeesToPaise(45844)).toBe(4584400);
  });
});

describe("verifyWebhookSignature — always-real, pure HMAC-SHA256 over the raw body", () => {
  const secret = "test_webhook_secret";
  const rawBody = JSON.stringify({ event: "payment.captured", payload: {} });

  function sign(body: string, key: string): string {
    return createHmac("sha256", key).update(body).digest("hex");
  }

  it("accepts a genuinely correct signature", () => {
    expect(verifyWebhookSignature(rawBody, sign(rawBody, secret), secret)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    expect(verifyWebhookSignature(rawBody, sign(rawBody, "wrong_secret"), secret)).toBe(false);
  });

  it("rejects a signature computed over a different (tampered) body", () => {
    const tamperedBody = JSON.stringify({ event: "payment.captured", payload: { tampered: true } });
    expect(verifyWebhookSignature(tamperedBody, sign(rawBody, secret), secret)).toBe(false);
  });

  it("rejects a garbage/non-hex signature without throwing", () => {
    expect(() => verifyWebhookSignature(rawBody, "not-a-real-signature", secret)).not.toThrow();
    expect(verifyWebhookSignature(rawBody, "not-a-real-signature", secret)).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(verifyWebhookSignature(rawBody, "", secret)).toBe(false);
  });
});

describe("MockRazorpayProvider — deterministic, never randomized", () => {
  it("createOrder never makes a network call and always returns a structurally valid, unique mock order id", async () => {
    const first = await mockRazorpayProvider.createOrder({ amountPaise: 100, currency: "INR", receipt: "r1" });
    const second = await mockRazorpayProvider.createOrder({ amountPaise: 100, currency: "INR", receipt: "r1" });
    expect(first.providerOrderId).toMatch(/^order_mock_/);
    expect(second.providerOrderId).toMatch(/^order_mock_/);
    expect(first.providerOrderId).not.toBe(second.providerOrderId); // generateMockOrderId is unique per call, never a fixed constant
  });

  it("verifyCheckoutSignature accepts EXACTLY the one sentinel signature and rejects everything else — no randomness, no partial match", () => {
    expect(
      mockRazorpayProvider.verifyCheckoutSignature({
        providerOrderId: "order_mock_x",
        providerPaymentId: "pay_mock_x",
        signature: "pact_mock_valid_signature",
      }),
    ).toBe(true);
    expect(
      mockRazorpayProvider.verifyCheckoutSignature({
        providerOrderId: "order_mock_x",
        providerPaymentId: "pay_mock_x",
        signature: "pact_mock_valid_signature_but_longer",
      }),
    ).toBe(false);
    expect(
      mockRazorpayProvider.verifyCheckoutSignature({
        providerOrderId: "order_mock_x",
        providerPaymentId: "pay_mock_x",
        signature: "",
      }),
    ).toBe(false);
  });

  it("is fully repeatable — the same inputs always produce the same verification result, run after run", () => {
    const input = { providerOrderId: "o", providerPaymentId: "p", signature: "pact_mock_valid_signature" };
    const results = Array.from({ length: 5 }, () => mockRazorpayProvider.verifyCheckoutSignature(input));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(true);
  });
});

describe("generateMockOrderId", () => {
  it("produces a distinct id on every call", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateMockOrderId()));
    expect(ids.size).toBe(20);
  });
});

describe("getPaymentProvider — env-var selection, mirrors getLlmProvider's own discipline", () => {
  it("defaults to the real Razorpay provider when PAYMENT_PROVIDER is unset", () => {
    delete process.env.PAYMENT_PROVIDER;
    expect(getPaymentProvider()).toBe(realRazorpayProvider);
  });

  it("selects the mock provider when PAYMENT_PROVIDER=mock outside production", () => {
    process.env.PAYMENT_PROVIDER = "mock";
    process.env = { ...process.env, NODE_ENV: "test" };
    expect(getPaymentProvider()).toBe(mockRazorpayProvider);
  });

  it("selects the mock provider case-insensitively", () => {
    process.env.PAYMENT_PROVIDER = "MOCK";
    process.env = { ...process.env, NODE_ENV: "test" };
    expect(getPaymentProvider()).toBe(mockRazorpayProvider);
  });

  it("falls back to the real provider on an unrecognized value", () => {
    process.env.PAYMENT_PROVIDER = "not-a-real-provider";
    expect(getPaymentProvider()).toBe(realRazorpayProvider);
  });

  // The single most important test in this file: production safety.
  it("NEVER selects the mock provider when NODE_ENV=production, regardless of PAYMENT_PROVIDER", () => {
    process.env.PAYMENT_PROVIDER = "mock";
    process.env = { ...process.env, NODE_ENV: "production" };
    expect(() => getPaymentProvider()).toThrow(/not permitted when NODE_ENV=production/);
  });

  it("production + unset/razorpay PAYMENT_PROVIDER is unaffected — the real provider is always selectable in production", () => {
    delete process.env.PAYMENT_PROVIDER;
    process.env = { ...process.env, NODE_ENV: "production" };
    expect(getPaymentProvider()).toBe(realRazorpayProvider);
  });
});

describe("isMockProviderActive", () => {
  it("is true only when PAYMENT_PROVIDER=mock and NODE_ENV is not production", () => {
    process.env.PAYMENT_PROVIDER = "mock";
    process.env = { ...process.env, NODE_ENV: "test" };
    expect(isMockProviderActive()).toBe(true);
  });

  it("is false in production even if PAYMENT_PROVIDER=mock is set", () => {
    process.env.PAYMENT_PROVIDER = "mock";
    process.env = { ...process.env, NODE_ENV: "production" };
    expect(isMockProviderActive()).toBe(false);
  });

  it("is false when PAYMENT_PROVIDER is unset or 'razorpay'", () => {
    delete process.env.PAYMENT_PROVIDER;
    expect(isMockProviderActive()).toBe(false);
    process.env.PAYMENT_PROVIDER = "razorpay";
    expect(isMockProviderActive()).toBe(false);
  });
});
