import { logger } from "./logger.js";

interface Config {
  openrouterApiKey: string;
  model: string;
  maxTokens: number;
  maxSteps: number;
  maxContextMessages: number;
  maxContextTokens: number;
  nodeEnv: string;
  screenPadding: number;
  /** Modo del clasificador de comandos: "on" (default) o "off" */
  classifierMode: "on" | "off";
  /** Modelo usado para clasificar comandos (debe ser rápido y barato) */
  classifierModel: string;
  /** Habilita el aprendizaje automático de overrides (default: false) */
  classifierLearn: boolean;
  /** Líneas sobre las que read devuelve outline en vez del archivo entero */
  outlineThreshold: number;
  /** Modelo de visión para preprocesar imágenes (opcional). Sin él, imágenes no se procesan. */
  visionModel: string | null;
  /** Máximo de tokens para respuestas del modelo de visión */
  visionMaxTokens: number;
}

function validateEnv(): Config {
  logger.info("Validating environment variables...");

  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterApiKey) {
    logger.error("Missing required env var: OPENROUTER_API_KEY");
    throw new Error("OPENROUTER_API_KEY environment variable is required. Create a .env file or set it in ~/.omega/.env");
  }

  const model = process.env.MODEL || "claude-haiku-4-5-20251001";
  const maxTokens = parseInt(process.env.MAX_TOKENS || "4096", 10);
  const maxSteps = parseInt(process.env.MAX_STEPS || "15", 10);
  const maxContextMessages = parseInt(process.env.MAX_CONTEXT_MESSAGES || "50", 10);
  const maxContextTokens = parseInt(process.env.MAX_CONTEXT_TOKENS || "100000", 10);
  const nodeEnv = process.env.NODE_ENV || "development";
  const screenPadding = parseInt(process.env.SCREEN_PADDING || "0", 10);
  const classifierMode = (process.env.CLASSIFIER_MODE || "on") as "on" | "off";
  const classifierModel = process.env.CLASSIFIER_MODEL || "anthropic/claude-haiku-4-5";
  const classifierLearn = process.env.CLASSIFIER_LEARN !== "false";
  const outlineThreshold = parseInt(process.env.OUTLINE_THRESHOLD || "200", 10);
  const visionModel = process.env.VISION_MODEL || null;
  const visionMaxTokens = parseInt(process.env.VISION_MAX_TOKENS || "512", 10);

  const config: Config = {
    openrouterApiKey,
    model,
    maxTokens,
    maxSteps,
    maxContextMessages,
    maxContextTokens,
    nodeEnv,
    screenPadding,
    classifierMode,
    classifierModel,
    classifierLearn,
    outlineThreshold,
    visionModel,
    visionMaxTokens,
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
