import { homedir } from "os";
import { join } from "path";
import dotenv from "dotenv";
import { AgentConfig } from "./agent-config.js";
import { CommandClassifier } from "./classifier/classifier.js";
import { OverrideManager } from "./classifier/overrides.js";
import { validateEnv, ResolvedConfig } from "./config.js";
import { logger } from "./logger.js";
import { OpenRouterProvider } from "./providers/openrouter-llm-provider.js";
import { Session } from "./session.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { AskUserTool } from "./tools/ask-user.js";
import { BashTool } from "./tools/bash.js";
import { EditTool } from "./tools/edit.js";
import { GrepTool } from "./tools/grep.js";
import { OutlineTool } from "./tools/outline.js";
import { ReadTool } from "./tools/read.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import { ToolSearchTool } from "./tools/tool-search.js";
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

  const fullSystemPrompt = buildSystemPrompt(config);

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

  const bashTool = new BashTool({
    classifier,
    defaultTimeoutMs: config.bashTimeoutMs,
  });

  const toolRegistry = new ToolRegistry(logger);

  // Tool de visión (solo si VISION_MODEL está configurado)
  const visionAskTool = config.visionModel
    ? new VisionAskTool(config.visionModel, config.visionMaxTokens, config.openrouterApiKey)
    : null;

  toolRegistry
    .registerLocal(new AskUserTool())
    .registerLocal(bashTool)
    .registerLocal(new GrepTool())
    .registerLocal(new OutlineTool())
    .registerLocal(new ReadTool(config.outlineThreshold))
    .registerLocal(new EditTool())
    .registerLocal(new WriteTool())
    // Servidores MCP desde .omega/mcp.json (carga lazy: no conectan hasta que se buscan)
    .configureMcp(loadMcpConfig(".omega"));

  // Registrar vision_ask si hay modelo de visión (incluso sin VISION_MODEL,
  // así el agente recibe un error manejado en vez de tool desconocida)
  if (visionAskTool) {
    toolRegistry.registerLocal(visionAskTool);
  }

  // Limpiar temp files de visión viejos (> 1 hora)
  cleanOldVisionTemps();

  // Matar procesos MCP hijos cuando omega sale (todos los caminos: exit, Ctrl+C, SIGTERM)
  process.on("exit", () => toolRegistry.disconnectAll());
  process.on("SIGTERM", () => process.exit(0));

  const agentConfig = new AgentConfig({
    systemPrompt: fullSystemPrompt,
    model: config.model,
    maxTokens: config.maxTokens,
    toolRegistry,
  });

  // tool_search va al AgentConfig (como tool local) para que el agente la use
  agentConfig.addTool(new ToolSearchTool(toolRegistry));

  const llmProvider = new OpenRouterProvider(config.openrouterApiKey);

  return { config, session, agentConfig, toolRegistry, classifier, llmProvider, visionAskTool };
}
