import { logger } from "./logger.js";

interface Config {
  anthropicApiKey: string;
  openrouterApiKey: string;
  model: string;
  maxTokens: number;
  maxSteps: number;
  maxContextMessages: number;
  maxContextTokens: number;
  nodeEnv: string;
  screenPadding: number;
}

function validateEnv(): Config {
  logger.info("Validating environment variables...");

  // OpenRouter es el provider por defecto (ver #18 para selección dinámica).
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterApiKey) {
    logger.error("Missing required env var: OPENROUTER_API_KEY");
    throw new Error("OPENROUTER_API_KEY environment variable is required. Create a .env file or set it in ~/.omega/.env");
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || "";

  const model = process.env.MODEL || "claude-haiku-4-5-20251001";
  const maxTokens = parseInt(process.env.MAX_TOKENS || "1024", 10);
  const maxSteps = parseInt(process.env.MAX_STEPS || "15", 10);
  const maxContextMessages = parseInt(process.env.MAX_CONTEXT_MESSAGES || "50", 10);
  const maxContextTokens = parseInt(process.env.MAX_CONTEXT_TOKENS || "100000", 10);
  const nodeEnv = process.env.NODE_ENV || "development";
  const screenPadding = parseInt(process.env.SCREEN_PADDING || "0", 10);

  const config: Config = {
    anthropicApiKey: apiKey,
    openrouterApiKey,
    model,
    maxTokens,
    maxSteps,
    maxContextMessages,
    maxContextTokens,
    nodeEnv,
    screenPadding,
  };

  logger.info("Config loaded successfully", {
    model,
    maxTokens,
    maxSteps,
    nodeEnv,
  });
  return config;
}

export { Config, validateEnv };
