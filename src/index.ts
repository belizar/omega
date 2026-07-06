import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import dotenv from "dotenv";
import { AgentConfig } from "./agent-config.js";
import { Context } from "./app-context.js";
import { CommandClassifier } from "./classifier/classifier.js";
import { OverrideManager } from "./classifier/overrides.js";
import { modalCommandsMap } from "./commands/index.js";
import { validateEnv, resolveAgentModel, getProfileByName, ResolvedConfig } from "./config.js";
import { logger } from "./logger.js";
import { OpenRouterProvider } from "./providers/openrouter-llm-provider.js";
import { Runner } from "./runner.js";
import { TUIFrontend } from "./frontend/tui-frontend.js";
import { HeadlessFrontend } from "./frontend/headless-frontend.js";
import { Frontend } from "./frontend/frontend.js";
import { parseCliArgs, CliArgs } from "./cli-args.js";
import { Message } from "./message.js";
import { Session } from "./session.js";
import { AskUserTool } from "./tools/ask-user.js";
import { BashTool } from "./tools/bash.js";
import { EditTool } from "./tools/edit.js";
import { GrepTool } from "./tools/grep.js";
import { OutlineTool } from "./tools/outline.js";
import { ReadTool } from "./tools/read.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import { ToolSearchTool } from "./tools/tool-search.js";
import { WriteTool } from "./tools/write.js";
import { loadMcpConfig } from "./mcp/client.js";
import {
  preprocessImages,
  cleanupTurnTemps,
  cleanOldVisionTemps,
  VisionAskTool,
} from "./tools/vision-ask.js";
import {
  DisplayAssistantText,
  DisplayToolCall,
  DisplayToolResult,
} from "./tui/components/display-text.js";
import { AnsiRenderer } from "./tui/markdown/ansi-renderer.js";
import { LineEditor } from "./tui/components/line-editor.js";
import { Spinner } from "./tui/components/spinner.js";
import { Screen } from "./tui/screen.js";
import { disableRawMode } from "./tui/terminal.js";
import { buildCabinetContext } from "./cabinet.js";
import { expandFileMentions } from "./tui/file-mentions.js";
import { collectHeroInfo } from "./tui/hero.js";

// Carga la .env del cwd (overrides por proyecto) y, como fallback, la global
// ~/.omega/.env. dotenv NO pisa vars ya seteadas, así que el cwd gana y la
// global completa el resto (tu API key) → `omega` anda desde cualquier carpeta.
// quiet: true → dotenv no imprime sus tips a stdout. Crítico para headless:
// stdout es el stream NDJSON del protocolo, no un log (cualquier línea extra
// rompe al consumidor que hace JSON.parse por línea).
dotenv.config({ quiet: true });
dotenv.config({ path: join(homedir(), ".omega", ".env"), quiet: true });

const SYSTEM_PROMPT = `Sos omega, un asistente de coding que trabaja en el proyecto del usuario.
Tenés tools para leer, escribir, editar y ejecutar comandos.

Tools esenciales (siempre disponibles):
- read: leé un archivo antes de editarlo.
- outline: vé la estructura de un archivo (firmas + rangos) sin leerlo entero.
  Usalo antes de read en archivos grandes; después read del rango que necesites.
- bash: explorá el proyecto (ls, grep, find) y ejecutá comandos.
- edit: para cambios quirúrgicos; el texto a reemplazar debe matchear exacto.
- write: solo para archivos nuevos o reescrituras completas.
- ask_user: pedí confirmación al usuario antes de acciones destructivas o cuando
  necesites que elija entre opciones.
- tool_search: buscá tools adicionales cuando necesites algo que las tools
  esenciales no cubren (ej: APIs, bases de datos, servicios externos).
  Después de encontrar una tool, usala directamente: ya queda registrada.
  **IMPORTANTE**: Si el usuario menciona un servicio externo (Supabase, Linear,
  Datadog, GitHub, etc.), usá tool_search **proactivamente** para ver si hay
  tools MCP disponibles, antes de intentar resolverlo con bash o read.
- vision_ask: si el usuario pegó una imagen y la descripción preliminar no
  cubre algo, preguntale al modelo de visión. Hacé todas tus preguntas en una
  sola llamada. Las imágenes persisten durante la sesión.

Cómo trabajás:
- Explorá lo necesario antes de cambiar nada: leé los archivos relevantes
  para entender el contexto.
- Si la tarea toca 3 o más archivos, emití un plan breve como texto antes de
  ejecutar: qué archivos vas a modificar, en qué orden y qué cambio en cada uno.
  No uses ask_user para esto; el plan es solo texto informativo. Después procedé.
- Después de editar código, verificá que no rompiste nada (typecheck, tests
  o lint según el proyecto) y corregí si hace falta.
- Typecheck y tests son necesarios pero no suficientes. Para cambios de
  comportamiento (features interactivas, cambios de lógica, flujos de usuario),
  escribí un plan de prueba manual de 2-3 pasos y pedile al usuario que lo
  ejecute con ask_user antes de declarar la tarea terminada. "Compila" no
  significa "funciona".
- Antes de instalar dependencias, borrar archivos, ejecutar comandos destructivos
  o hacer cambios irreversibles, usá ask_user para pedir confirmación.

IMPORTANTE — Clasificador de seguridad en bash:
Omega tiene un clasificador que evalúa cada comando bash antes de ejecutarlo.
Si el clasificador bloquea un comando, la tool bash te devolverá un mensaje
"BLOQUEADO POR CLASIFICADOR DE SEGURIDAD" con la razón. En ese caso:
- NO intentes el mismo comando con otra sintaxis, herramienta o enfoque.
- Informale al usuario qué pasó y por qué el comando fue bloqueado.
- Si el usuario quiere ejecutarlo igual, usá ask_user para preguntarle
  explícitamente. Si confirma, llamá a bash con el mismo comando exacto
  y el parámetro adicional force: true.

Estilo:
- Respondé siempre en español.
- Sé conciso: explicá brevemente qué hiciste y por qué, sin resúmenes largos.
- Usá estructura markdown para que se lea bien en la terminal:
  - Títulos de sección con ## (o ** para subtítulos en negrita).
  - Una línea EN BLANCO entre párrafos, y antes y después de títulos, listas y
    bloques de código. Esto es lo que genera el espaciado.
  - Listas con "- " para los puntos.
  - \`código inline\` para paths, comandos y nombres de archivo.
  - Bloques de código con \`\`\` cuando muestres código o salida.
  - Cada sección con su título en una línea \`##\` (NO como item de lista
    numerada tipo "1. Título"), así queda separada y resaltada.
- La estructura es para legibilidad, no decoración: seguí conciso, sin relleno.`;

function loadProjectContext(): string {
  const parts: string[] = [];

  // Git info: rama y nombre del proyecto
  try {
    const branch = execSync("git branch --show-current", { encoding: "utf-8", timeout: 2000 }).trim();
    if (branch) parts.push(`Rama: ${branch}`);
  } catch { /* no es repo git */ }

  try {
    const remote = execSync("git remote get-url origin", { encoding: "utf-8", timeout: 2000 }).trim();
    // Extraer nombre del repo: git@github.com:user/repo.git → user/repo, https://github.com/user/repo → user/repo
    const match = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) parts.push(`Repo: ${match[1]}`);
  } catch { /* no remote */ }

  // AGENT.md si existe
  const agentPath = "AGENT.md";
  if (existsSync(agentPath)) {
    const content = readFileSync(agentPath, "utf-8").trim();
    if (content) {
      const firstLine = content.split("\n")[0].replace(/^#\s*/, "").trim();
      const sizeKB = Math.round(content.length / 1024);
      parts.push(`AGENT.md: ${firstLine} (${sizeKB} KB)`);
    }
  }

  if (parts.length === 0) return "";
  return `\n\n## Contexto del proyecto\n\n${parts.map(p => `- ${p}`).join("\n")}\n\n${existsSync(agentPath) ? "Leé AGENT.md con read cuando necesites contexto de reglas y convenciones. " : ""}No asumas nada sobre el proyecto sin haberlo explorado.`;
}

function loadMcpContext(): string {
  const servers = loadMcpConfig(".omega");
  if (!servers || Object.keys(servers).length === 0) return "";
  const names = Object.keys(servers).join(", ");
  return `\n\n## Servicios MCP disponibles\n\nTenés tools MCP configuradas para: ${names}.\nCuando el usuario mencione alguno de estos servicios, usá \`tool_search\` con el nombre del servicio para descubrir las tools disponibles y usalas directamente.`;
}

/** Deliverables para el humano: distinto de la memoria del agente (cabinet). */
function loadDocsContext(docsDir: string | null): string {
  if (!docsDir) return "";
  return `\n\n## Documentos para el humano (deliverables)\n\nCuando el usuario te pida escribir un documento PARA ÉL —un plan, review, summary, informe, HTML— es un **deliverable**, algo que va a consumir él, no memoria del agente. Escribilo con \`write\` en \`${docsDir}\` (su carpeta de docs), con un nombre descriptivo.\n\nNO uses el cabinet para esto: el cabinet es la **memoria de omega, para omega** (conocimiento durable que el agente consolida para su propio contexto). Los deliverables son para que los lea el humano — otro lugar, otro propósito.`;
}

/**
 * Fabrica el ejecutor de un turno, parametrizado por el frontend. Es el núcleo
 * del seam: la MISMA lógica de turno maneja la TUI y el headless — sólo cambia
 * el `Frontend` que recibe los eventos. Antes vivía como closure dentro de la
 * rama TUI de main(); extraerlo lo vuelve reutilizable sin duplicarlo.
 */
function createTurnRunner(deps: {
  ctx: Context;
  frontend: Frontend;
  llmProvider: OpenRouterProvider;
  agentConfig: AgentConfig;
  classifier?: CommandClassifier;
  config: ResolvedConfig;
}): () => Promise<void> {
  const { ctx, frontend, llmProvider, agentConfig, classifier, config } = deps;

  const resolvePrimaryModel = (): string =>
    resolveAgentModel(
      "primary",
      getProfileByName(ctx.session.profile)!,
      ctx.session.modelOverrides as Record<string, string>,
    );
  const resolveClassifierModel = (): string =>
    ctx.session.modelOverrides.classifier ?? config.classifierModel;

  return async function runTurn(): Promise<void> {
    const session = ctx.session;
    const abortController = new AbortController();
    frontend.setAbortController(abortController);

    const run = new Runner({
      llmProvider,
      agentConfig,
      maxSteps: config.maxSteps,
      maxContextTokens: config.maxContextTokens,
      signal: abortController.signal,
      model: resolvePrimaryModel(),
      onAskUser: (question: string) => frontend.askUser(question),
    });

    // Aplicar overrides de /model para este turno (primary + classifier).
    agentConfig.setModel(resolvePrimaryModel());
    classifier?.setModel(resolveClassifierModel());

    try {
      frontend.turnStarted();
      for await (const event of run.run(session.getContext())) {
        if (event.type === "state") {
          session.addMessage(event.message);
        } else {
          frontend.handleEvent(event);
        }
      }
      frontend.turnEnded();
      session.compactWorkingContext();
    } catch (err: unknown) {
      frontend.turnEnded();
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Runner error", msg);
      frontend.notify(`Error: ${msg}`);
    } finally {
      frontend.clearAbortController();
    }

    const metrics = run.getMetrics();
    session.addUsage(
      metrics.totalInputTokens,
      metrics.totalOutputTokens,
      metrics.totalCost,
    );
    session.addStepUsage(run.getStepUsage().slice());

    // El core arma las métricas en crudo; cada frontend decide cómo mostrarlas
    // (la TUI dibuja la línea `~ ctx:`; el headless las emite estructuradas).
    frontend.reportMetrics({
      contextTokens: session.contextTokens,
      toolCalls: metrics.totalToolCalls,
      inputTokens: metrics.totalInputTokens,
      outputTokens: metrics.totalOutputTokens,
      turnCost: metrics.totalCost,
      totalCost: session.totalCost,
      durationMs: metrics.durationMs,
      toolErrors: metrics.totalToolErrors,
      rereads: metrics.rereads,
    });
    run.resetMetrics();
  };
}

/** Lee todo stdin hasta EOF (para `-p -` o `-p` sin valor). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Modo headless one-shot: corre UN prompt hasta terminar y sale. No toca la
 * terminal — construye un frontend que emite a stdout (la cabeza que le ponemos
 * al mismo cuerpo). El exit code refleja si el turno terminó ok.
 */
async function runHeadlessMode(deps: {
  config: ResolvedConfig;
  session: Session;
  agentConfig: AgentConfig;
  toolRegistry: ToolRegistry;
  classifier?: CommandClassifier;
  llmProvider: OpenRouterProvider;
  cli: CliArgs;
}): Promise<void> {
  const { config, session, agentConfig, toolRegistry, classifier, llmProvider, cli } = deps;

  const prompt = cli.prompt ?? (await readStdin());
  if (!prompt.trim()) {
    process.stderr.write('omega: prompt vacío (usá -p "…" o pasalo por stdin)\n');
    process.exit(2);
  }

  // Screen inerte: satisface la dependencia del Context sin enganchar la
  // terminal (no llamamos screen.start()). El headless nunca renderiza por acá.
  // TODO: idealmente Context depende de un ScreenPort, no del Screen concreto.
  const screen = new Screen(config.screenPadding);
  const ctx = new Context({ session, agentConfig, screen, toolRegistry, classifier });

  const frontend = new HeadlessFrontend({
    prompt,
    format: cli.format,
    model: config.model,
    sessionId: session.id,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });

  const runTurn = createTurnRunner({
    ctx,
    frontend,
    llmProvider,
    agentConfig,
    classifier,
    config,
  });

  frontend.start();

  // Ctrl+C aborta el turno en curso (corta la llamada al LLM y deja emitir el
  // `result`) en vez de matar el proceso en seco. Un solo listener, en el driver.
  process.on("SIGINT", () => {
    if (!frontend.interrupt()) process.exit(130); // sin turno activo → salir
  });

  // @-mentions se expanden (útil para tareas que referencian archivos); las
  // imágenes de visión no se soportan en headless v1.
  const resolved = await expandFileMentions(prompt);
  session.addUserMessage(resolved.text || prompt);

  await runTurn();

  frontend.stop();
  toolRegistry.disconnectAll();
  process.exit(frontend.hadError ? 1 : 0);
}

const main = async () => {
  const cli = parseCliArgs(process.argv.slice(2));
  const config = validateEnv();
  const session = new Session({
    dir: ".omega/sessions",
    maxContextTokens: config.maxContextTokens,
    model: config.model,
  });
  logger.setLogFile(`.omega/logs/${session.id}.log`);
  logger.info("Omega agent starting", { session: session.id });

  const fullSystemPrompt = SYSTEM_PROMPT + loadProjectContext() + loadMcpContext() + buildCabinetContext() + loadDocsContext(config.docsDir);

  // ── Hero (se imprime en frontend.start()) ─────────────────────────
  const toolCount = 8; // read, write, edit, bash, grep, outline, tool_search, ask_user
  const heroInfo = collectHeroInfo({
    profile: session.profile,
    model: config.model,
    visionModel: config.visionModel,
    toolCount,
  });

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

  const haikuAgent = new AgentConfig({
    systemPrompt: fullSystemPrompt,
    model: config.model,
    maxTokens: config.maxTokens,
    toolRegistry,
  });

  // tool_search va al AgentConfig (como tool local) para que el agente la use
  haikuAgent.addTool(new ToolSearchTool(toolRegistry));

  const llmprovider = new OpenRouterProvider(config.openrouterApiKey);

  // ── Bifurcación de frontend (seam) ────────────────────────────────
  // Headless one-shot: otra "cabeza" para el mismo cuerpo. Sale sin construir
  // nada de TUI. Todo lo de arriba (config, sesión, tools, provider) es core
  // compartido; recién acá se decide quién maneja al agente.
  if (cli.headless) {
    await runHeadlessMode({
      config,
      session,
      agentConfig: haikuAgent,
      toolRegistry,
      classifier,
      llmProvider: llmprovider,
      cli,
    });
    return;
  }

  // Vision resuelve su modelo efectivo por turno (override de /model ?? perfil).
  // Lo usa el loop TUI en la preparación del turno (primary/classifier los
  // resuelve el propio createTurnRunner).
  const resolveVisionModel = (): string | null =>
    ctx.session.modelOverrides.vision ?? config.visionModel;

  const screen = new Screen(config.screenPadding);
  const spinner = new Spinner(screen);
  const assistantText = new DisplayAssistantText(screen, new AnsiRenderer());
  const toolCallText = new DisplayToolCall(screen);
  const toolResultText = new DisplayToolResult(screen);

  const ctx = new Context({
    session,
    agentConfig: haikuAgent,
    screen,
    toolRegistry,
    classifier,
  });

  const lineEditor = new LineEditor();

  // Puerto de entrada (seam). Envuelve las instancias de TUI; el core (loop)
  // habla con esta interfaz, no con screen/spinner/lineEditor directamente.
  const frontend = new TUIFrontend({
    screen,
    spinner,
    assistantText,
    toolCallText,
    toolResultText,
    lineEditor,
    ctx,
    modals: modalCommandsMap,
    heroInfo,
    getVerbose: () => ctx.verbose,
  });

  // Ejecutor de turno (seam): la misma lógica que usa el headless, con la
  // TUIFrontend como consumidor de eventos. Lee ctx.session en cada turno (no
  // una captura) para que /resume tome efecto.
  const runTurn = createTurnRunner({
    ctx,
    frontend,
    llmProvider: llmprovider,
    agentConfig: haikuAgent,
    classifier,
    config,
  });

  frontend.start();

  while (true) {
    // El type-ahead (mensajes encolados mientras el agente trabajaba) lo drena
    // el propio frontend dentro de nextInput().
    const inp = await frontend.nextInput();

    if (inp.kind === "exit") {
      logger.info("Omega agent stopped");
      // El listener de stdin del Screen mantiene vivo el event loop, así que
      // un break dejaría el proceso colgado. Salimos explícito; el handler de
      // process.on("exit") restaura la raw mode.
      frontend.stop();
      process.exit(0);
    }

    // Comando slash o modal ya resuelto por el frontend. Si un modal dejó un
    // runner pendiente (ej: /resume), lo corremos; si no, seguimos al prompt.
    if (inp.kind === "none") {
      if (ctx.session.pendingRunner) {
        ctx.session.consumePendingRunner();
        await runTurn();
      }
      continue;
    }

    const session = ctx.session;

    const resolvedInput = await expandFileMentions(inp.text);
    const userContent: Message["content"] = [];
    if (resolvedInput.text) {
      userContent.push({ type: "text", text: resolvedInput.text });
    }
    for (const img of resolvedInput.images) {
      userContent.push(img);
    }

    // Imágenes pegadas con Ctrl+V (no procesadas por expandFileMentions)
    const pendingImages = inp.pastedImages;
    for (const img of pendingImages) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.ext === "png" ? "image/png" :
                      img.ext === "jpg" || img.ext === "jpeg" ? "image/jpeg" :
                      img.ext === "gif" ? "image/gif" :
                      img.ext === "webp" ? "image/webp" :
                      `image/${img.ext}`,
          data: img.data.toString("base64"),
        },
      });
    }

    // Nada que mandar (ej. un encolado que expandió a vacío): saltamos el turno.
    if (userContent.length === 0) continue;

    // ── Preprocesador de visión ──────────────────────────────────────────────
    const hasImages = userContent.some(
      (b) => typeof b === "object" && "type" in b && b.type === "image",
    );
    let turnTempPaths: string[] = [];

    // Modelo de visión efectivo para este turno (override de /model ?? perfil).
    const turnVisionModel = resolveVisionModel();
    if (visionAskTool && turnVisionModel) {
      visionAskTool.setModel(turnVisionModel);
    }

    if (hasImages && turnVisionModel) {
      const visionResult = await preprocessImages(
        userContent as Record<string, unknown>[],
        turnVisionModel,
        config.visionMaxTokens,
        config.openrouterApiKey,
      );
      turnTempPaths = visionResult.savedPaths;

      // Inyectar descripción preliminar al inicio
      if (visionResult.description) {
        userContent.unshift({ type: "text", text: visionResult.description });
      }

      // Acumular imágenes en vision_ask para que las pueda reenviar
      // en turnos futuros (no solo el actual).
      // IMPORTANTE: debe hacerse ANTES de quitar las imágenes de userContent.
      if (visionAskTool && visionResult.savedImages.length > 0) {
        // Las imágenes todavía están en userContent — las capturamos ahora
        const imgBlocks = userContent.filter(
          (b) => typeof b === "object" && "type" in b && b.type === "image",
        ) as unknown as import("./message.js").ImageMessage[];
        visionAskTool.addImages(imgBlocks);
      }

      // Remover los bloques de imagen del userContent — el modelo principal
      // (ej: DeepSeek) no es multimodal y crashearía con un 404.
      // Las imágenes ya fueron descrita por VISION_MODEL y vision_ask
      // puede reenviarlas si el agente necesita más detalle.
      for (let i = userContent.length - 1; i >= 0; i--) {
        const b = userContent[i];
        if (typeof b === "object" && "type" in b && b.type === "image") {
          userContent.splice(i, 1);
        }
      }
    } else if (hasImages) {
      // Sin VISION_MODEL: placeholder de degradación
      userContent.unshift({
        type: "text",
        text: "[Imagen pegada — VISION_MODEL no configurado. No puedo ver la imagen.]",
      });
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Si solo hay texto, lo pasamos como string simple para mantener
    // compatibilidad con el formato legacy
    const firstItem = userContent[0];
    if (
      userContent.length === 1 &&
      typeof firstItem === "object" &&
      "type" in firstItem &&
      firstItem.type === "text"
    ) {
      session.addUserMessage((firstItem as { type: "text"; text: string }).text);
    } else {
      session.addUserMessage(userContent);
    }

    // ── Runner ──
    await runTurn();

    // Limpiar temp files de visión del turno
    cleanupTurnTemps(turnTempPaths);
  }
};

main().catch((err) => {
  disableRawMode();
  console.log(err);
  logger.error("Fatal error", err);
  process.exit(1);
});
