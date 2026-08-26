import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeProvider, MissingApiKeyError } from "./claude";
import { LlmUnavailableError } from "./provider";

// claudeProvider.generateAgentMessage() checks for ANTHROPIC_API_KEY and
// throws before it ever constructs the Anthropic client or makes a
// network call, so this test needs no mocking and makes no real API
// request.
describe("claudeProvider.generateAgentMessage — missing API key", () => {
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

  it("rejects with a clear MissingApiKeyError instead of crashing mysteriously", async () => {
    await expect(
      claudeProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: { outcome: "EXACT_MATCH" },
        instruction: "Say something.",
      }),
    ).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  // Agents catch the provider-agnostic LlmUnavailableError (not the
  // Claude-specific class) to fall back to a deterministic message —
  // this is what makes that possible.
  it("is an instance of the provider-agnostic LlmUnavailableError", async () => {
    await expect(
      claudeProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: {},
        instruction: "Say something.",
      }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});
