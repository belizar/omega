import { Context } from "../app-context.js";
import { CoreServices, createAgentStack, SharedAgentDeps } from "../core.js";
import { logger } from "../logger.js";
import { Session } from "../session.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { TurnRunner } from "../turn-runner.js";
import { Screen } from "../tui/screen.js";
import { createWorkspace, Workspace } from "../workspace.js";
import { WebFrontend } from "./web-frontend.js";

/** Una sesión viva hospedada por el server: su hub, su workspace y su loop. */
export interface SessionHandle {
  readonly id: string;
  title: string;
  readonly frontend: WebFrontend;
  readonly workspace: Workspace;
  readonly session: Session;
  readonly toolRegistry: ToolRegistry;
}

/** Vista serializable de una sesión para el protocolo (GET /sessions). */
export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  isolated: boolean;
  branch?: string;
  clients: number;
  live: true;
}

export interface CreateSessionOpts {
  /** Título legible (default: la branch, o prefijo del id). */
  title?: string;
  /** Si true, la sesión corre en un git worktree dedicado (aislamiento real). */
  worktree?: boolean;
  /** Nombre de la branch del worktree (default: omega/<idcorto>). */
  branch?: string;
  /** Branch base de la que se crea (default: config.worktree.baseBranch, o HEAD). */
  base?: string;
}

/**
 * Hospeda N sesiones de agente en un solo proceso. Cada sesión es independiente:
 * su propia conversación (`Session`), su propio hub de clientes SSE
 * (`WebFrontend`), su propio stack de tools enraizado en su workspace, y su
 * propio loop concurrente. Lo que comparten —config, provider LLM, clasificador,
 * skills, system prompt— entra por `SharedAgentDeps` y no se copia.
 *
 * Es la forma del backend de nube: hoy son loops en un proceso local; mañana el
 * mismo mapa vive en un contenedor con auth adelante. El `WebFrontend` como hub
 * ya resolvió "múltiples clientes por sesión"; esto resuelve "múltiples sesiones".
 */
export class SessionManager {
  #sessions = new Map<string, SessionHandle>();
  /** Promesa del loop de cada sesión: se resuelve cuando su cleanup terminó. */
  #loops = new Map<string, Promise<void>>();
  #base: CoreServices;
  #baseDir: string;
  #sessionsDir: string;
  #shared: SharedAgentDeps;

  constructor(base: CoreServices, opts: { baseDir: string; sessionsDir?: string }) {
    this.#base = base;
    this.#baseDir = opts.baseDir;
    this.#sessionsDir = opts.sessionsDir ?? ".omega/sessions";
    this.#shared = {
      config: base.config,
      classifier: base.classifier,
      visionAskTool: base.visionAskTool,
      systemPrompt: base.systemPrompt,
      skills: base.skills,
      // Sin sandbox: el aislamiento de sesión es por git worktree, no contenedor.
    };
  }

  /** Crea una sesión, arranca su loop y devuelve su handle. */
  async create(opts: CreateSessionOpts = {}): Promise<SessionHandle> {
    const { config } = this.#base;

    const session = new Session({
      dir: this.#sessionsDir,
      maxContextTokens: config.maxContextTokens,
      model: config.model,
    });

    const workspace = await createWorkspace({
      baseDir: this.#baseDir,
      sessionId: session.id,
      isolate: opts.worktree,
      branch: opts.branch,
      base: opts.base,
      config: config.worktree,
    });

    // Stack de tools enraizado en el workspace de ESTA sesión.
    const { toolRegistry, agentConfig } = createAgentStack(workspace.cwd, this.#shared);

    const frontend = new WebFrontend({ model: config.model, sessionId: session.id });
    const screen = new Screen(config.screenPadding);
    const ctx = new Context({
      session,
      agentConfig,
      screen,
      toolRegistry,
      classifier: this.#base.classifier,
    });

    // CoreServices por-sesión: comparte provider/config/classifier, pero lleva la
    // session, el agentConfig y el toolRegistry propios. TurnRunner lee de acá.
    const perSessionCore: CoreServices = {
      ...this.#base,
      session,
      agentConfig,
      toolRegistry,
    };
    const turnRunner = new TurnRunner(perSessionCore, ctx, frontend);

    const handle: SessionHandle = {
      id: session.id,
      title: opts.title?.trim() || workspace.branch || session.id.slice(0, 8),
      frontend,
      workspace,
      session,
      toolRegistry,
    };
    this.#sessions.set(handle.id, handle);

    frontend.start();
    // Cada sesión corre su propio loop concurrente (promesa independiente: no
    // bloquea a las otras). Guardamos la promesa para poder esperar su cleanup.
    this.#loops.set(handle.id, this.#runLoop(handle, turnRunner));

    logger.info("sesión creada", {
      id: handle.id,
      cwd: workspace.cwd,
      isolated: workspace.isolated,
    });
    return handle;
  }

  get(id: string): SessionHandle | undefined {
    return this.#sessions.get(id);
  }

  has(id: string): boolean {
    return this.#sessions.has(id);
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((h) => ({
      id: h.id,
      title: h.title,
      cwd: h.workspace.cwd,
      isolated: h.workspace.isolated,
      branch: h.workspace.branch,
      clients: h.frontend.clientCount,
      live: true,
    }));
  }

  /** El loop de un agente: input de la red → turno. Uno por sesión. */
  async #runLoop(handle: SessionHandle, turnRunner: TurnRunner): Promise<void> {
    const { frontend, session } = handle;
    try {
      for (;;) {
        const inp = await frontend.nextInput();
        if (inp.kind === "exit") break;
        if (inp.kind === "none") continue;
        session.addUserMessage(inp.text);
        await turnRunner.run();
      }
    } catch (err: unknown) {
      logger.error("loop de sesión murió", {
        id: handle.id,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await this.#cleanup(handle);
    }
  }

  /** Baja una sesión: corta su loop (inyecta exit), libera sus recursos y espera
   *  a que el cleanup termine. */
  async remove(id: string): Promise<void> {
    const handle = this.#sessions.get(id);
    if (!handle) return;
    // Desbloquea el loop parado en nextInput; el cleanup lo hace el finally del loop.
    handle.frontend.submitInput("/exit");
    await this.#loops.get(id);
  }

  /** Baja todas las sesiones (shutdown del server). */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.remove(id)));
  }

  async #cleanup(handle: SessionHandle): Promise<void> {
    if (!this.#sessions.delete(handle.id)) return; // ya limpiada
    this.#loops.delete(handle.id);
    handle.frontend.stop();
    // Cierra procesos MCP hijos que ESTA sesión haya arrancado (registry propio).
    try {
      handle.toolRegistry.disconnectAll();
    } catch {
      /* best-effort */
    }
    await handle.workspace.dispose();
    logger.info("sesión bajada", { id: handle.id });
  }
}
