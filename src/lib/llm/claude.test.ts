import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateMerchantMessage, MissingApiKeyError } from "./claude";

// generateMerchantMessage() checks for ANTHROPIC_API_KEY and throws
// before it ever constructs the Anthropic client or makes a network
// call, so this test needs no mocking and makes no real API request.
describe("generateMerchantMessage — missing API key", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  // 6. Missing ANTHROPIC_API_KEY produces a controlled error.
  it("rejects with a clear MissingApiKeyError instead of crashing mysteriously", async () => {
    await expect(
      generateMerchantMessage({
        outcome: "EXACT_MATCH",
        sku: "TEST-SKU",
        requestedQuantity: 1,
        offeredQuantity: 1,
        unitPrice: 100,
        deliveryDays: 5,
        reasons: [],
      }),
    ).rejects.toBeInstanceOf(MissingApiKeyError);
  });
});
