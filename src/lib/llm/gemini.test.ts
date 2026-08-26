import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { geminiProvider, MissingGeminiApiKeyError } from "./gemini";
import { LlmUnavailableError } from "./provider";

// geminiProvider.generateAgentMessage() checks for GEMINI_API_KEY and
// throws before it ever constructs the Gemini client or makes a
// network call, so this test needs no mocking and makes no real API
// request.
describe("geminiProvider.generateAgentMessage — missing API key", () => {
  const originalKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  it("rejects with a clear MissingGeminiApiKeyError instead of crashing mysteriously", async () => {
    await expect(
      geminiProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: { outcome: "EXACT_MATCH" },
        instruction: "Say something.",
      }),
    ).rejects.toBeInstanceOf(MissingGeminiApiKeyError);
  });

  it("is an instance of the provider-agnostic LlmUnavailableError", async () => {
    await expect(
      geminiProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: {},
        instruction: "Say something.",
      }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});
