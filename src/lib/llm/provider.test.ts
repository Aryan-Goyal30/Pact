import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLlmProvider } from "./provider";
import { claudeProvider } from "./claude";
import { geminiProvider } from "./gemini";

describe("getLlmProvider — LLM_PROVIDER selection", () => {
  const originalProvider = process.env.LLM_PROVIDER;

  beforeEach(() => {
    delete process.env.LLM_PROVIDER;
  });

  afterEach(() => {
    if (originalProvider === undefined) {
      delete process.env.LLM_PROVIDER;
    } else {
      process.env.LLM_PROVIDER = originalProvider;
    }
    vi.restoreAllMocks();
  });

  it("defaults to Claude when LLM_PROVIDER is unset", () => {
    expect(getLlmProvider()).toBe(claudeProvider);
  });

  it("selects Claude explicitly", () => {
    process.env.LLM_PROVIDER = "claude";
    expect(getLlmProvider()).toBe(claudeProvider);
  });

  it("selects Gemini when LLM_PROVIDER=gemini", () => {
    process.env.LLM_PROVIDER = "gemini";
    expect(getLlmProvider()).toBe(geminiProvider);
  });

  it("is case-insensitive", () => {
    process.env.LLM_PROVIDER = "GEMINI";
    expect(getLlmProvider()).toBe(geminiProvider);
  });

  it("falls back to Claude (with a warning, not a crash) for an unrecognized value", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.LLM_PROVIDER = "not-a-real-provider";
    expect(getLlmProvider()).toBe(claudeProvider);
    expect(warnSpy).toHaveBeenCalled();
  });
});
