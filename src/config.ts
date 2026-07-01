import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { logger } from "./logger.js";

// ── Tipos ────────────────────────────────────────────────────────────────────

interface AgentProfile {
  /** Modelo por defecto para todos los agentes del perfil. */
  model: string;
  maxTokens?: number;
  maxSteps?: number;
  maxContextTokens?: number;
  /** Modelo específico para el agente de visión (hereda model si no se setea). */
  vision?: { model?: string; maxTokens?: number };
  /** Modelo específico para el clasificador de comandos (hereda model si no se setea). */
  classifier?: { model?: string; maxTokens?: number; learn?: boolean };
}

interface OmegaConfig {
  /** Perfil activo por defecto. */
  defaultProfile: string;
  /** Perfiles nombrados. */
  profiles: Record<string, AgentProfile>;
}

interface ResolvedConfig {
  openrouterApiKey: string;
  /** Perfil activo (nombre). */
  profile: string;
  model: string;
  maxTokens: number;
  maxSteps: number;
  maxContextMessages: number;
  maxContextTokens: number;
  nodeEnv: string;
  screenPadding: number;
  classifierMode: "on" | "off";
  classifierModel: string;
  classifierLearn: boolean;
  outlineThreshold: number;
  visionModel: string | null;
  visionMaxTokens: number;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: OmegaConfig = {
  defaultProfile: "default",
  profiles: {
    default: {
      model: "anthropic/claude-haiku-4-5-20251001",
      maxTokens: 4096,
      maxSteps: 15,
      maxContextTokens: 100_000,
    },
  },
};

// ── Carga y merge ────────────────────────────────────────────────────────────

function loadJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    logger.warn(`Failed to parse ${path}`, { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Carga ~/.omega/config.json y .omega/config.json, mergea.
 *  En modo test no lee archivos: devuelve los defaults hardcodeados. */
export function loadOmegaConfig(): OmegaConfig {
  if (process.env.NODE_ENV === "test") {
    return { ...DEFAULT_CONFIG, profiles: { ...DEFAULT_CONFIG.profiles } };
  }

  const globalPath = join(homedir(), ".omega", "config.json");
  const projectPath = join(process.cwd(), ".omega", "config.json");

  let merged: OmegaConfig = { ...DEFAULT_CONFIG, profiles: { ...DEFAULT_CONFIG.profiles } };

  // 1. Global
  const global = loadJsonFile(globalPath);
  if (global) {
    if (typeof global.defaultProfile === "string") merged.defaultProfile = global.defaultProfile;
    if (global.profiles && typeof global.profiles === "object") {
      for (const [name, p] of Object.entries(global.profiles as Record<string, unknown>)) {
        merged.profiles[name] = { ...merged.profiles[name], ...(p as AgentProfile) };
      }
    }
  }

  // 2. Proyecto (pisa)
  const project = loadJsonFile(projectPath);
  if (project) {
    if (typeof project.defaultProfile === "string") merged.defaultProfile = project.defaultProfile;
    if (project.profiles && typeof project.profiles === "object") {
      for (const [name, p] of Object.entries(project.profiles as Record<string, unknown>)) {
        merged.profiles[name] = { ...merged.profiles[name], ...(p as AgentProfile) };
      }
    }
  }

  return merged;
}

// ── Resolver perfil ──────────────────────────────────────────────────────────

/** Dado un nombre de perfil, devuelve la configuración resuelta. */
function resolveProfile(
  profileName: string,
  config: OmegaConfig,
  apiKey: string,
): ResolvedConfig {
  const profile = config.profiles[profileName];
  if (!profile) {
    logger.warn(`Profile "${profileName}" not found, falling back to "${config.defaultProfile}"`);
    return resolveProfile(config.defaultProfile, config, apiKey);
  }

  const model = profile.model;
  const maxTokens = profile.maxTokens ?? 4096;
  const maxSteps = profile.maxSteps ?? 15;
  const maxContextTokens = profile.maxContextTokens ?? 100_000;

  // Visión: hereda model del perfil si no se especifica
  const visionModel = profile.vision?.model ?? model;
  const visionMaxTokens = profile.vision?.maxTokens ?? 512;

  // Clasificador: hereda model del perfil si no se especifica
  const classifierModel = profile.classifier?.model ?? "anthropic/claude-haiku-4-5";
  const classifierLearn = profile.classifier?.learn ?? false;

  // Si no hay modelo de visión configurado explícitamente, null (desactivado)
  const effectiveVisionModel = profile.vision?.model ? visionModel : null;

  return {
    openrouterApiKey: apiKey,
    profile: profileName,
    model,
    maxTokens,
    maxSteps,
    maxContextMessages: 50, // no va en perfil por ahora
    maxContextTokens,
    nodeEnv: process.env.NODE_ENV || "development",
    screenPadding: parseInt(process.env.SCREEN_PADDING || "20", 10),
    classifierMode: (process.env.CLASSIFIER_MODE || "on") as "on" | "off",
    classifierModel,
    classifierLearn,
    outlineThreshold: parseInt(process.env.OUTLINE_THRESHOLD || "200", 10),
    visionModel: effectiveVisionModel,
    visionMaxTokens,
  };
}

// ── Validación principal ─────────────────────────────────────────────────────

function validateEnv(): ResolvedConfig {
  logger.info("Validating environment and loading config...");

  const apiKey = process.env.OPENROUTER_API_KEY || "";
  const omegaConfig = loadOmegaConfig();
  const profileName = process.env.OMEGA_PROFILE || omegaConfig.defaultProfile;
  const resolved = resolveProfile(profileName, omegaConfig, apiKey);

  logger.info("Config loaded", {
    profile: resolved.profile,
    model: resolved.model,
    visionModel: resolved.visionModel,
    classifierModel: resolved.classifierModel,
  });

  return resolved;
}

// ── Helpers públicos ─────────────────────────────────────────────────────────

/** Recarga y devuelve los perfiles disponibles (para el comando /profile list). */
function listProfiles(activeProfile?: string): { names: string[]; active: string; defaultProfile: string } {
  const config = loadOmegaConfig();
  const active = activeProfile ?? process.env.OMEGA_PROFILE ?? config.defaultProfile;
  return {
    names: Object.keys(config.profiles),
    active,
    defaultProfile: config.defaultProfile,
  };
}

/** Devuelve un perfil resuelto por nombre (para /profile switch). */
function getProfileByName(name: string): AgentProfile | null {
  const config = loadOmegaConfig();
  return config.profiles[name] ?? null;
}

/** Resuelve el modelo para un agente específico dado un perfil y overrides. */
function resolveAgentModel(
  agent: "primary" | "vision" | "classifier",
  profile: AgentProfile,
  overrides: { primary?: string; vision?: string; classifier?: string },
): string {
  // Override tiene prioridad absoluta
  if (agent === "primary" && overrides.primary) return overrides.primary;
  if (agent === "vision" && overrides.vision) return overrides.vision;
  if (agent === "classifier" && overrides.classifier) return overrides.classifier;

  // Spec del agente en el perfil
  if (agent === "vision") return profile.vision?.model ?? profile.model;
  if (agent === "classifier") return profile.classifier?.model ?? profile.model;

  return profile.model;
}

export {
  AgentProfile,
  OmegaConfig,
  ResolvedConfig,
  validateEnv,
  listProfiles,
  getProfileByName,
  resolveAgentModel,
};