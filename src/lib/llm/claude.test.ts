import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { claudeProvider, MissingApiKeyError } from "./claude";
import { LlmUnavailableError, ProviderRateLimitedError } from "./provider";

// Provider-failure handling: messages.create is mocked at the SDK
// boundary so this test can exercise a real 429 (Anthropic.RateLimitError)
// without making a real network call. The Anthropic module itself is
// kept real (via importOriginal) so `error instanceof Anthropic.APIError`
// in claude.ts is exercised genuinely, not just a mock shaped to look
// like one.
const mockedCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  function FakeAnthropic() {
    return { messages: { create: mockedCreate } };
  }
  // The error classes (APIError, RateLimitError, etc.) are exported as
  // named exports of the MODULE itself, not as static properties of the
  // default export — copied here from `actual` (not `actual.default`)
  // so claude.ts's own `error instanceof Anthropic.APIError` check
  // (which reads them off the default import, per this SDK's own CJS/ESM
  // interop shape) exercises real, genuine classes, never a mock merely
  // shaped to look like one.
  for (const key of Object.keys(actual)) {
    if (key === "default") continue;
    Object.defineProperty(FakeAnthropic, key, {
      value: (actual as unknown as Record<string, unknown>)[key],
      enumerable: true,
    });
  }
  return { ...actual, default: FakeAnthropic as unknown as typeof actual.default };
});

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

// Provider-failure handling: a 429 from Claude (Anthropic.RateLimitError)
// must be recognized and turned into the provider-agnostic
// ProviderRateLimitedError — an LlmUnavailableError subclass — so
// buyerAgent.ts/merchantAgent.ts fall back to a deterministic message
// instead of failing the whole negotiation turn with a 500.
describe("claudeProvider.generateAgentMessage — rate limit (HTTP 429)", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockedCreate.mockReset();
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  function rateLimitError() {
    return new Anthropic.RateLimitError(429, {}, "rate limited", new Headers());
  }

  it("turns a real Anthropic.RateLimitError into ProviderRateLimitedError", async () => {
    mockedCreate.mockRejectedValue(rateLimitError());

    await expect(
      claudeProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: {},
        instruction: "Say something.",
      }),
    ).rejects.toBeInstanceOf(ProviderRateLimitedError);
  });

  it("is still an instance of the provider-agnostic LlmUnavailableError", async () => {
    mockedCreate.mockRejectedValue(rateLimitError());

    await expect(
      claudeProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: {},
        instruction: "Say something.",
      }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("names the provider as Claude in the resulting error", async () => {
    mockedCreate.mockRejectedValue(rateLimitError());

    try {
      await claudeProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: {},
        instruction: "Say something.",
      });
      expect.unreachable("expected generateAgentMessage to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRateLimitedError);
      expect((error as InstanceType<typeof ProviderRateLimitedError>).provider).toBe("Claude");
    }
  });

  it("does NOT reinterpret a non-429 APIError as a rate limit — rethrown unchanged", async () => {
    mockedCreate.mockRejectedValue(new Anthropic.AuthenticationError(401, {}, "bad key", new Headers()));

    await expect(
      claudeProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: {},
        instruction: "Say something.",
      }),
    ).rejects.not.toBeInstanceOf(ProviderRateLimitedError);
  });

  it("does NOT reinterpret an unrelated error (e.g. a network failure) as a rate limit", async () => {
    mockedCreate.mockRejectedValue(new Error("network exploded"));

    await expect(
      claudeProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: {},
        instruction: "Say something.",
      }),
    ).rejects.toThrow("network exploded");
  });
});
