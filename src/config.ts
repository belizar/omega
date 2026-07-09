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
  /** Directorio donde omega escribe DELIVERABLES para el humano (planes,
   *  reviews, summaries, HTMLs). Distinto de la memoria del agente (cabinet).
   *  Ej: tu vault de Obsidian. Soporta `~`. */
  docsDir?: string;
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
  /** Timeout por defecto (ms) para comandos bash. El modelo puede pisarlo por
   *  llamada con el param `timeout` (en segundos). Env: BASH_TIMEOUT_MS. */
  bashTimeoutMs: number;
  visionModel: string | null;
  visionMaxTokens: number;
  /** Directorio de deliverables para el humano (o null si no se configuró). */
  docsDir: string | null;
  /** Sandbox opcional: corre el bash del agente dentro de un contenedor Docker
   *  (con el cwd montado) en vez del host. OFF por default — es para contextos
   *  NO atendidos (benchmark, nube) donde no hay humano que apruebe. En la TUI
   *  local se usan permisos, no aislación. Env: OMEGA_SANDBOX, OMEGA_SANDBOX_IMAGE. */
  sandbox: { enabled: boolean; image: string };
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: OmegaConfig = {
  defaultProfile: "default",
  profiles: {
    default: {
      model: "anthropic/claude-haiku-4-5-20251001",
      maxTokens: 4096,
      maxSteps: 15,
      // maxContextTokens se deriva de la ventana del modelo si no se setea.
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
    if (typeof global.docsDir === "string") merged.docsDir = global.docsDir;
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
    if (typeof project.docsDir === "string") merged.docsDir = project.docsDir;
    if (project.profiles && typeof project.profiles === "object") {
      for (const [name, p] of Object.entries(project.profiles as Record<string, unknown>)) {
        merged.profiles[name] = { ...merged.profiles[name], ...(p as AgentProfile) };
      }
    }
  }

  return merged;
}

// ── Ventana de contexto por modelo ───────────────────────────────────────────

/** Ventana de contexto (tokens) conocida por modelo. Fallback conservador. */
function modelContextWindow(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("deepseek")) return 1_000_000;
  if (m.includes("gemini")) return 1_000_000;
  if (m.includes("gpt-5") || m.includes("gpt-4.1")) return 400_000;
  if (m.includes("claude") || m.includes("sonnet") || m.includes("opus") || m.includes("haiku")) return 200_000;
  return 128_000; // desconocido: conservador
}

/** Presupuesto de contexto por defecto: 85% de la ventana del modelo, dejando
 *  headroom para system prompt + output. pruneContext queda como válvula de
 *  seguridad que casi nunca dispara, en vez de amputar la conversación. */
function defaultMaxContextTokens(model: string): number {
  return Math.floor(modelContextWindow(model) * 0.85);
}

/** Expande un leading `~` a la home. null si no se pasó path. */
function expandHome(p: string | undefined): string | null {
  if (!p) return null;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
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
  const maxContextTokens = profile.maxContextTokens ?? defaultMaxContextTokens(model);

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
    screenPadding: parseInt(process.env.SCREEN_PADDING || "6", 10),
    classifierMode: (process.env.CLASSIFIER_MODE || "on") as "on" | "off",
    classifierModel,
    classifierLearn,
    outlineThreshold: parseInt(process.env.OUTLINE_THRESHOLD || "200", 10),
    bashTimeoutMs: parseInt(process.env.BASH_TIMEOUT_MS || "120000", 10),
    visionModel: effectiveVisionModel,
    visionMaxTokens,
    docsDir: expandHome(config.docsDir),
    sandbox: {
      enabled: process.env.OMEGA_SANDBOX === "1" || process.env.OMEGA_SANDBOX === "true",
      image: process.env.OMEGA_SANDBOX_IMAGE || "node:22-slim",
    },
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