import { faker } from "@faker-js/faker";
import { Config } from "../../config.js";

export class ConfigFactory {
  static createConfig(overrides?: Partial<Config>): Config {
    return {
      anthropicApiKey: overrides?.anthropicApiKey || faker.string.alphanumeric(32),
      model: overrides?.model || "claude-haiku-4-5-20251001",
      maxTokens: overrides?.maxTokens || faker.number.int({ min: 512, max: 4096 }),
      maxSteps: overrides?.maxSteps || faker.number.int({ min: 5, max: 20 }),
      maxContextMessages: overrides?.maxContextMessages ?? 50,
      nodeEnv: overrides?.nodeEnv || "test",
    };
  }

  static createProductionConfig(overrides?: Partial<Config>): Config {
    return this.createConfig({
      nodeEnv: "production",
      maxTokens: 1024,
      maxSteps: 15,
      ...overrides,
    });
  }

  static createDevelopmentConfig(overrides?: Partial<Config>): Config {
    return this.createConfig({
      nodeEnv: "development",
      maxTokens: 2048,
      maxSteps: 20,
      ...overrides,
    });
  }
}
