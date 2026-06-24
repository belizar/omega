import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { validateEnv } from "../config.js";

describe("Config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should throw error if OPENROUTER_API_KEY is missing", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(() => validateEnv()).toThrow(
      "OPENROUTER_API_KEY",
    );
  });

  it("should use default values for optional env vars", () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    delete process.env.MODEL;
    delete process.env.MAX_TOKENS;
    delete process.env.MAX_STEPS;
    delete process.env.NODE_ENV;

    const config = validateEnv();

    expect(config.openrouterApiKey).toBe("test-key");
    expect(config.model).toBe("claude-haiku-4-5-20251001");
    expect(config.maxTokens).toBe(4096);
    expect(config.maxSteps).toBe(15);
    expect(config.nodeEnv).toBe("development");
  });

  it("should parse custom environment variables", () => {
    process.env.OPENROUTER_API_KEY = "custom-key";
    process.env.MODEL = "claude-3-opus";
    process.env.MAX_TOKENS = "2048";
    process.env.MAX_STEPS = "20";
    process.env.NODE_ENV = "production";

    const config = validateEnv();

    expect(config.openrouterApiKey).toBe("custom-key");
    expect(config.model).toBe("claude-3-opus");
    expect(config.maxTokens).toBe(2048);
    expect(config.maxSteps).toBe(20);
    expect(config.nodeEnv).toBe("production");
  });});

