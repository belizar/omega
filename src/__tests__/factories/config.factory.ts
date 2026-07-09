import { faker } from "@faker-js/faker";
import { ResolvedConfig } from "../../config.js";

export class ConfigFactory {
  static createConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
    return {
      openrouterApiKey: overrides?.openrouterApiKey || faker.string.alphanumeric(32),
      profile: overrides?.profile || "default",
      model: overrides?.model || "anthropic/claude-haiku-4-5-20251001",
      maxTokens: overrides?.maxTokens || faker.number.int({ min: 512, max: 4096 }),
      maxSteps: overrides?.maxSteps || faker.number.int({ min: 5, max: 20 }),
      maxContextMessages: overrides?.maxContextMessages ?? 50,
      maxContextTokens: overrides?.maxContextTokens ?? 100_000,
      nodeEnv: overrides?.nodeEnv || "test",
      screenPadding: overrides?.screenPadding ?? 20,
      classifierMode: overrides?.classifierMode || "off",
      classifierModel: overrides?.classifierModel || "anthropic/claude-haiku-4-5",
      classifierLearn: overrides?.classifierLearn ?? false,
      outlineThreshold: overrides?.outlineThreshold ?? 200,
      bashTimeoutMs: overrides?.bashTimeoutMs ?? 120_000,
      visionModel: overrides?.visionModel ?? null,
      visionMaxTokens: overrides?.visionMaxTokens ?? 512,
      docsDir: overrides?.docsDir ?? null,
      worktree: overrides?.worktree ?? {
        dir: ".omega/worktrees",
        baseBranch: "",
        copy: [],
        command: "",
        removeCommand: "",
      },
      sandbox: overrides?.sandbox ?? { enabled: false, image: "node:22-slim" },
    };
  }

  static createProductionConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
    return this.createConfig({
      nodeEnv: "production",
      maxTokens: 1024,
      maxSteps: 15,
      ...overrides,
    });
  }

  static createDevelopmentConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
    return this.createConfig({
      nodeEnv: "development",
      maxTokens: 2048,
      maxSteps: 20,
      ...overrides,
    });
  }
}