import { logger } from "./logger.js";

interface Config {
  anthropicApiKey: string;
  model: string;
  maxTokens: number;
  maxSteps: number;
  nodeEnv: string;
}

function validateEnv(): Config {
  logger.info("Validating environment variables...");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error("Missing required env var: ANTHROPIC_API_KEY");
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const model = process.env.MODEL || "claude-haiku-4-5-20251001";
  const maxTokens = parseInt(process.env.MAX_TOKENS || "1024", 10);
  const maxSteps = parseInt(process.env.MAX_STEPS || "15", 10);
  const nodeEnv = process.env.NODE_ENV || "development";

  const config: Config = {
    anthropicApiKey: apiKey,
    model,
    maxTokens,
    maxSteps,
    nodeEnv,
  };

  logger.info("Config loaded successfully", { model, maxTokens, maxSteps, nodeEnv });
  return config;
}

export { Config, validateEnv };
