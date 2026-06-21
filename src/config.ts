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
  /** Cantidad de turnos a mantener en el contexto activo cuando hay dossier (default: 4) */
  lastKTurns: number;
}

function validateEnv(): Config {
  logger.info("Validating environment variables...");

  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterApiKey) {
    logger.error("Missing required env var: OPENROUTER_API_KEY");
    throw new Error("OPENROUTER_API_KEY environment variable is required. Create a .env file or set it in ~/.omega/.env");
  }

  const model = process.env.MODEL || "claude-haiku-4-5-20251001";
  const maxTokens = parseInt(process.env.MAX_TOKENS || "1024", 10);
  const maxSteps = parseInt(process.env.MAX_STEPS || "15", 10);
  const maxContextMessages = parseInt(process.env.MAX_CONTEXT_MESSAGES || "50", 10);
  const maxContextTokens = parseInt(process.env.MAX_CONTEXT_TOKENS || "100000", 10);
  const nodeEnv = process.env.NODE_ENV || "development";
  const screenPadding = parseInt(process.env.SCREEN_PADDING || "0", 10);
  const classifierMode = (process.env.CLASSIFIER_MODE || "on") as "on" | "off";
  const classifierModel = process.env.CLASSIFIER_MODEL || "anthropic/claude-haiku-4-5";
  const classifierLearn = process.env.CLASSIFIER_LEARN === "true";
  const lastKTurns = parseInt(process.env.LAST_K_TURNS || "4", 10);

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
    lastKTurns,
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
