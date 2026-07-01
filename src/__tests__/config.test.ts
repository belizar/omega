import { describe, it, expect } from "vitest";
import { loadOmegaConfig } from "../config.js";

describe("Config", () => {
  it("should have sensible defaults with the hardcoded profile", () => {
    const config = loadOmegaConfig();
    expect(config.defaultProfile).toBe("default");
    expect(config.profiles.default).toBeDefined();
    expect(config.profiles.default.model).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(config.profiles.default.maxTokens).toBe(4096);
    expect(config.profiles.default.maxSteps).toBe(15);
    expect(config.profiles.default.maxContextTokens).toBe(100_000);
  });

  it("should return a fresh copy each call (no mutation)", () => {
    const a = loadOmegaConfig();
    const b = loadOmegaConfig();
    expect(a).toEqual(b);
    a.defaultProfile = "otro";
    expect(b.defaultProfile).toBe("default");
  });
});

