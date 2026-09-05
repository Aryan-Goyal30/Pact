import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@google/genai";
import { geminiProvider, MissingGeminiApiKeyError } from "./gemini";
import { LlmUnavailableError, ProviderRateLimitedError } from "./provider";

// Provider-failure handling: generateContent is mocked at the SDK
// boundary so this test can exercise a real 429 (Gemini's free-tier
// generate_content quota — 5 requests/minute was the figure observed
// for the previously-used gemini-3.6-flash model; see gemini.ts's
// GEMINI_MODEL for the model actually in use) without making a real
// network call or depending on actually hitting the live quota.
// ApiError itself is kept real (via importOriginal) so
// gemini.ts's own `error instanceof ApiError` check is exercised
// genuinely, not just a mock shaped to look like one.
const mockedGenerateContent = vi.fn();
vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  return {
    ...actual,
    GoogleGenAI: vi.fn().mockImplementation(function FakeGoogleGenAI() {
      return { models: { generateContent: mockedGenerateContent } };
    }),
  };
});

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

// Provider-failure handling: a 429 from Gemini (quota exhausted) must be
// recognized and turned into the provider-agnostic ProviderRateLimitedError
// — an LlmUnavailableError subclass — so buyerAgent.ts/merchantAgent.ts
// fall back to a deterministic message instead of failing the whole
// negotiation turn with a 500.
describe("geminiProvider.generateAgentMessage — rate limit (HTTP 429)", () => {
  const originalKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
    mockedGenerateContent.mockReset();
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  it("turns a real Gemini 429 ApiError into ProviderRateLimitedError", async () => {
    mockedGenerateContent.mockRejectedValue(
      new ApiError({ message: "Resource has been exhausted (e.g. check quota).", status: 429 }),
    );

    await expect(
      geminiProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: {},
        instruction: "Say something.",
      }),
    ).rejects.toBeInstanceOf(ProviderRateLimitedError);
  });

  it("is still an instance of the provider-agnostic LlmUnavailableError", async () => {
    mockedGenerateContent.mockRejectedValue(new ApiError({ message: "quota exceeded", status: 429 }));

    await expect(
      geminiProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: {},
        instruction: "Say something.",
      }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("names the provider as Gemini in the resulting error", async () => {
    mockedGenerateContent.mockRejectedValue(new ApiError({ message: "quota exceeded", status: 429 }));

    try {
      await geminiProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: {},
        instruction: "Say something.",
      });
      expect.unreachable("expected generateAgentMessage to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRateLimitedError);
      expect((error as InstanceType<typeof ProviderRateLimitedError>).provider).toBe("Gemini");
    }
  });

  it("does NOT reinterpret a non-429 ApiError as a rate limit — rethrown unchanged", async () => {
    mockedGenerateContent.mockRejectedValue(new ApiError({ message: "invalid API key", status: 401 }));

    await expect(
      geminiProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: {},
        instruction: "Say something.",
      }),
    ).rejects.not.toBeInstanceOf(ProviderRateLimitedError);
  });

  it("does NOT reinterpret an unrelated error (e.g. a network failure) as a rate limit", async () => {
    mockedGenerateContent.mockRejectedValue(new Error("network exploded"));

    await expect(
      geminiProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: {},
        instruction: "Say something.",
      }),
    ).rejects.toThrow("network exploded");
  });
});

// Provider-failure handling: a 503 from Gemini ("This model is currently
// experiencing high demand" / status text UNAVAILABLE — observed live
// against the real API) must be recognized exactly like a 429 and turned
// into the same provider-agnostic ProviderRateLimitedError, so it follows
// the same recoverable path — see gemini.ts's own catch block. Before
// this fix, a 503 escaped uncaught: parseBuyerIntent re-threw it (it
// isn't an LlmUnavailableError), the intent API route's outer catch
// returned a generic 500, and the buyer never saw the intended
// "Automatic understanding isn't available right now" fallback message.
describe("geminiProvider.generateAgentMessage — provider unavailable (HTTP 503)", () => {
  const originalKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
    mockedGenerateContent.mockReset();
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  it("turns a real Gemini 503 ApiError into ProviderRateLimitedError", async () => {
    mockedGenerateContent.mockRejectedValue(
      new ApiError({ message: "This model is currently experiencing high demand.", status: 503 }),
    );

    await expect(
      geminiProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: {},
        instruction: "Say something.",
      }),
    ).rejects.toBeInstanceOf(ProviderRateLimitedError);
  });

  it("is still an instance of the provider-agnostic LlmUnavailableError", async () => {
    mockedGenerateContent.mockRejectedValue(new ApiError({ message: "model overloaded", status: 503 }));

    await expect(
      geminiProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: {},
        instruction: "Say something.",
      }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("names the provider as Gemini in the resulting error", async () => {
    mockedGenerateContent.mockRejectedValue(new ApiError({ message: "model overloaded", status: 503 }));

    try {
      await geminiProvider.generateAgentMessage({
        systemPrompt: "You are a test persona.",
        context: {},
        instruction: "Say something.",
      });
      expect.unreachable("expected generateAgentMessage to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRateLimitedError);
      expect((error as InstanceType<typeof ProviderRateLimitedError>).provider).toBe("Gemini");
    }
  });
});
