import { homedir } from "os";
import { join } from "path";
import dotenv from "dotenv";
import { AgentConfig } from "./agent-config.js";
import { CommandClassifier } from "./classifier/classifier.js";
import { OverrideManager } from "./classifier/overrides.js";
import { validateEnv, ResolvedConfig } from "./config.js";
import { logger } from "./logger.js";
import { OpenRouterProvider } from "./providers/openrouter-llm-provider.js";
import { Sandbox } from "./sandbox.js";
import { Session } from "./session.js";
import { loadSkills, Skill } from "./skills.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { SkillTool } from "./tools/skill.js";
import { AskUserTool } from "./tools/ask-user.js";
import { BashTool } from "./tools/bash.js";
import { EditTool } from "./tools/edit.js";
import { GrepTool } from "./tools/grep.js";
import { OutlineTool } from "./tools/outline.js";
import { ReadTool } from "./tools/read.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import { ToolSearchTool } from "./tools/tool-search.js";
import { WebFetchTool } from "./tools/web-fetch.js";
import { WriteTool } from "./tools/write.js";
import { cleanOldVisionTemps, VisionAskTool } from "./tools/vision-ask.js";
import { loadMcpConfig } from "./mcp/client.js";

// Carga la .env del cwd (overrides por proyecto) y, como fallback, la global
// ~/.omega/.env. dotenv NO pisa vars ya seteadas, así que el cwd gana y la
// global completa el resto (tu API key) → `omega` anda desde cualquier carpeta.
// quiet: true → dotenv no imprime sus tips a stdout. Crítico para headless:
// stdout es el stream NDJSON del protocolo, no un log (cualquier línea extra
// rompe al consumidor que hace JSON.parse por línea).
dotenv.config({ quiet: true });
dotenv.config({ path: join(homedir(), ".omega", ".env"), quiet: true });

/**
 * Servicios de core compartidos por todos los frontends: lo que se arma una vez
 * (config, sesión, tools, provider) sin importar quién maneje al agente. Cada
 * `FrontendMode` los recibe y monta su propia "cabeza" encima.
 */
export interface CoreServices {
  config: ResolvedConfig;
  session: Session;
  agentConfig: AgentConfig;
  toolRegistry: ToolRegistry;
  classifier?: CommandClassifier;
  llmProvider: OpenRouterProvider;
  visionAskTool: VisionAskTool | null;
  /** Skills instaladas (compartidas por todas las sesiones). */
  skills: Skill[];
  /** System prompt ya armado (compartido). */
  systemPrompt: string;
}

/**
 * Dependencias compartidas por TODAS las sesiones al armar su stack de tools.
 * Lo que NO depende del workspace: config, clasificador, visión, prompt, skills.
 * El SessionManager las reusa para construir un stack por-sesión con su cwd.
 */
export interface SharedAgentDeps {
  config: ResolvedConfig;
  classifier?: CommandClassifier;
  visionAskTool: VisionAskTool | null;
  systemPrompt: string;
  skills: Skill[];
  /** Sandbox opcional (contenedor). En multi-sesión va undefined: el aislamiento
   *  es por git worktree, no por contenedor. */
  sandbox?: Sandbox;
}

/**
 * Arma un stack de agente (toolRegistry + agentConfig) enraizado en un `cwd`.
 * Las file-tools resuelven paths relativos contra ese cwd, así cada sesión opera
 * en su propio workspace dentro de un mismo proceso. `buildCore` lo usa con el
 * cwd del proceso; el SessionManager, con el cwd de cada sesión.
 */
export function createAgentStack(
  cwd: string,
  deps: SharedAgentDeps,
): { toolRegistry: ToolRegistry; agentConfig: AgentConfig } {
  const bashTool = new BashTool({
    classifier: deps.classifier,
    defaultTimeoutMs: deps.config.bashTimeoutMs,
    sandbox: deps.sandbox,
    cwd,
  });

  const toolRegistry = new ToolRegistry(logger);
  toolRegistry
    .registerLocal(new AskUserTool())
    .registerLocal(bashTool)
    .registerLocal(new GrepTool(cwd))
    .registerLocal(new OutlineTool(cwd))
    .registerLocal(new ReadTool(deps.config.outlineThreshold, cwd))
    .registerLocal(new EditTool(cwd))
    .registerLocal(new WriteTool(cwd))
    .registerLocal(new WebFetchTool())
    // MCP: primero el .omega del worktree de ESTA sesión (cada proyecto sus
    // servers), con fallback al global ~/.omega. Antes se cargaba de process.cwd
    // (el cwd del daemon), que en el modelo multi-sesión no es el del worktree →
    // los MCPs no aparecían. Fresh worktrees que omega crea no tienen .omega
    // (gitignoreado) → caen al global.
    .configureMcp(loadMcpConfig(join(cwd, ".omega")) ?? loadMcpConfig(join(homedir(), ".omega")));

  if (deps.visionAskTool) {
    toolRegistry.registerLocal(deps.visionAskTool);
  }

  const agentConfig = new AgentConfig({
    // Re-armado con el cwd de ESTA sesión: el contexto de proyecto (git/AGENT.md) y
    // de MCP salen del worktree, no del cwd del daemon. (deps.systemPrompt es el
    // default del proceso.)
    systemPrompt: buildSystemPrompt(deps.config, deps.skills, cwd),
    model: deps.config.model,
    maxTokens: deps.config.maxTokens,
    toolRegistry,
  });
  agentConfig.addTool(new ToolSearchTool(toolRegistry));
  if (deps.skills.length > 0) {
    agentConfig.addTool(new SkillTool(deps.skills));
  }

  return { toolRegistry, agentConfig };
}

/**
 * Arma los servicios de core compartidos: todo lo que no depende de quién maneje
 * al agente. Después un `FrontendMode` monta su cabeza encima. Registra los
 * handlers de salida (matan procesos MCP hijos en todos los caminos).
 */
export async function buildCore(): Promise<CoreServices> {
  const config = validateEnv();
  const session = new Session({
    dir: ".omega/sessions",
    maxContextTokens: config.maxContextTokens,
    model: config.model,
  });
  logger.setLogFile(`.omega/logs/${session.id}.log`);
  logger.info("Omega agent starting", { session: session.id });

  // Skills del usuario (.omega/skills/<name>/SKILL.md, proyecto + global). Solo
  // name+description entran al system prompt; el body se carga con la tool `skill`.
  const skills = loadSkills();

  // Prompt "default" (cwd del proceso). createAgentStack lo re-arma por-sesión con
  // el cwd del worktree, así el contexto de proyecto/MCP es el correcto por sesión.
  const fullSystemPrompt = buildSystemPrompt(config, skills);

  // ── Clasificador de comandos ──────────────────────────────────────
  let classifier: CommandClassifier | undefined;
  if (config.classifierMode === "on") {
    const overrides = await OverrideManager.load(".omega");
    classifier = new CommandClassifier(
      overrides,
      {
        apiKey: config.openrouterApiKey,
        model: config.classifierModel,
        learnEnabled: config.classifierLearn,
      },
    );
  }

  // Sandbox opcional: el workspace persistente (contenedor) donde corre el bash
  // del agente. Solo se crea si está habilitado; si no, el bash corre en el host.
  const sandbox = config.sandbox.enabled
    ? new Sandbox({ image: config.sandbox.image, sessionId: session.id })
    : undefined;
  if (sandbox) {
    // Matar el contenedor al salir. (SIGKILL no corre esto → el keep-alive `sleep`
    // con tope y el --rm hacen que un huérfano se autodestruya.)
    process.on("exit", () => sandbox.stop());
  }

  // Tool de visión (solo si VISION_MODEL está configurado)
  const visionAskTool = config.visionModel
    ? new VisionAskTool(config.visionModel, config.visionMaxTokens, config.openrouterApiKey)
    : null;

  // El stack de tools de la sesión por defecto, enraizado en el cwd del proceso.
  // El mismo helper lo usa el SessionManager con el cwd de cada sesión.
  const { toolRegistry, agentConfig } = createAgentStack(process.cwd(), {
    config,
    classifier,
    visionAskTool,
    systemPrompt: fullSystemPrompt,
    skills,
    sandbox,
  });

  // Limpiar temp files de visión viejos (> 1 hora)
  cleanOldVisionTemps();

  // Matar procesos MCP hijos cuando omega sale (todos los caminos: exit, Ctrl+C, SIGTERM)
  process.on("exit", () => toolRegistry.disconnectAll());
  process.on("SIGTERM", () => process.exit(0));

  const llmProvider = new OpenRouterProvider(config.openrouterApiKey);

  return {
    config,
    session,
    agentConfig,
    toolRegistry,
    classifier,
    llmProvider,
    visionAskTool,
    skills,
    systemPrompt: fullSystemPrompt,
  };
}
