import { randomUUID } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { Context } from "../app-context.js";
import { CoreServices, createAgentStack, SharedAgentDeps } from "../core.js";
import { logger } from "../logger.js";
import { Session } from "../session.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { TurnRunner } from "../turn-runner.js";
import { Screen } from "../tui/screen.js";
import {
  attachWorkspace,
  createWorkspace,
  detectBranch,
  detectProject,
  Workspace,
} from "../workspace.js";
import { SessionIndex } from "./session-index.js";
import { SessionStatus, WebFrontend } from "./web-frontend.js";

/** Una sesión viva hospedada por el server: su hub, su workspace y su loop. */
export interface SessionHandle {
  readonly id: string;
  title: string;
  /** Dir del proyecto (repo) al que pertenece, para agrupar en el sidebar. */
  readonly project: string;
  readonly frontend: WebFrontend;
  readonly workspace: Workspace;
  readonly session: Session;
  readonly toolRegistry: ToolRegistry;
}

/** Vista serializable de una sesión (viva o dormida) para el protocolo. */
export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  /** Dir del proyecto (repo) — el sidebar agrupa por esto. */
  project: string;
  isolated: boolean;
  branch?: string;
  clients: number;
  /** true = corriendo ahora; false = dormida (en el índice, revivible). */
  live: boolean;
  /** Estado si está viva: idle / running / waiting. */
  status?: SessionStatus;
  lastActive?: number;
}

export type SessionMode = "shared" | "create" | "attach";

export interface CreateSessionOpts {
  /** Título legible (default: la branch, o prefijo del id). */
  title?: string;
  /** Cómo se arma el workspace:
   *  - shared: comparte el cwd del server (default).
   *  - create: Omega crea un git worktree nuevo (branch/base).
   *  - attach: se engancha a un dir/worktree que YA existe (cwd), sin crear ni
   *    borrar nada (tu flujo tree.sh). */
  mode?: SessionMode;
  /** Directorio a attachear (solo mode attach). */
  cwd?: string;
  /** Legacy: equivale a mode "create". Lo usa el sidebar viejo. */
  worktree?: boolean;
  /** Nombre de la branch del worktree (mode create; default: omega/<idcorto>). */
  branch?: string;
  /** Branch base de la que se crea (mode create; default: config, o HEAD). */
  base?: string;
}

/** Ahora vs "hace un rato" sin depender del reloj en tests que lo prohíben. */
const now = (): number => Date.now();

/**
 * Hospeda N sesiones de agente en un solo proceso. Cada sesión es independiente:
 * su propia conversación (`Session`), su hub de clientes SSE (`WebFrontend`), su
 * stack de tools enraizado en su workspace, y su loop concurrente. Lo compartido
 * —config, provider, clasificador, skills, prompt— entra por `SharedAgentDeps`.
 *
 * Persistencia (Increment A): cada sesión se registra en un `SessionIndex` global.
 * Al reiniciar el server, `listAll()` muestra las **dormidas** del índice y
 * `revive()` las trae de vuelta cargando su transcript del disco y re-attacheando
 * su workspace. El server deja de tener amnesia: bajar un loop NO destruye nada.
 */
export class SessionManager {
  #sessions = new Map<string, SessionHandle>();
  /** Promesa del loop de cada sesión: se resuelve cuando su cleanup terminó. */
  #loops = new Map<string, Promise<void>>();
  #base: CoreServices;
  #baseDir: string;
  #sessionsDir: string;
  #index: SessionIndex;
  #shared: SharedAgentDeps;

  constructor(
    base: CoreServices,
    opts: { baseDir: string; sessionsDir?: string; index?: SessionIndex },
  ) {
    this.#base = base;
    this.#baseDir = opts.baseDir;
    // Store GLOBAL (daemon): los transcripts viven en ~/.omega/sessions,
    // independientes del proyecto → revivir cross-project es trivial. Inyectable
    // para tests. El `project` es solo para agrupar, no dónde se guarda.
    this.#sessionsDir = opts.sessionsDir ?? join(homedir(), ".omega", "sessions");
    this.#index = opts.index ?? new SessionIndex();
    this.#shared = {
      config: base.config,
      classifier: base.classifier,
      visionAskTool: base.visionAskTool,
      systemPrompt: base.systemPrompt,
      skills: base.skills,
      // Sin sandbox: el aislamiento de sesión es por git worktree, no contenedor.
    };
  }

  /** Path absoluto del transcript de una sesión (para el índice). */
  #sessionFile(id: string): string {
    return resolve(this.#sessionsDir, `${id}.json`);
  }

  /** Crea una sesión nueva, la registra en el índice y arranca su loop. */
  async create(opts: CreateSessionOpts = {}): Promise<SessionHandle> {
    const { config } = this.#base;

    // id primero: el workspace lo necesita, y el project sale del cwd del workspace.
    const id = randomUUID();
    const { workspace, owned } = await this.#buildWorkspace(id, opts);
    const project = await detectProject(workspace.cwd);

    const session = new Session({
      id,
      dir: this.#sessionsDir,
      maxContextTokens: config.maxContextTokens,
      model: config.model,
    });

    const title = opts.title?.trim() || workspace.branch || id.slice(0, 8);
    const handle = this.#spawn(session, workspace, title, project);

    const ts = now();
    this.#index.upsert({
      id: handle.id,
      title,
      project,
      sessionFile: this.#sessionFile(handle.id),
      cwd: workspace.cwd,
      branch: workspace.branch,
      isolated: workspace.isolated,
      owned,
      createdAt: ts,
      lastActive: ts,
    });

    logger.info("sesión creada", {
      id: handle.id,
      cwd: workspace.cwd,
      isolated: workspace.isolated,
      owned,
    });
    return handle;
  }

  /** Arma el workspace según el modo. Devuelve también si Omega es dueño del worktree. */
  async #buildWorkspace(
    sessionId: string,
    opts: CreateSessionOpts,
  ): Promise<{ workspace: Workspace; owned: boolean }> {
    const { config } = this.#base;
    const mode: SessionMode = opts.mode ?? (opts.worktree ? "create" : "shared");

    if (mode === "attach") {
      const cwd = opts.cwd ? resolve(opts.cwd) : "";
      if (!cwd || !existsSync(cwd)) {
        throw new Error(`attach: el directorio "${opts.cwd ?? ""}" no existe`);
      }
      const isolated = cwd !== resolve(this.#baseDir);
      const branch = isolated ? await detectBranch(cwd) : undefined;
      // owned=false: es TU worktree (tree.sh); Omega no lo crea ni lo borra.
      return {
        workspace: attachWorkspace({
          baseDir: this.#baseDir,
          cwd,
          isolated,
          branch,
          owned: false,
          config: config.worktree,
        }),
        owned: false,
      };
    }

    if (mode === "create") {
      const workspace = await createWorkspace({
        baseDir: this.#baseDir,
        sessionId,
        isolate: true,
        branch: opts.branch,
        base: opts.base,
        config: config.worktree,
      });
      // createWorkspace cae a compartido si baseDir no es repo git → owned solo si aisló.
      return { workspace, owned: workspace.isolated };
    }

    // shared
    const workspace = await createWorkspace({
      baseDir: this.#baseDir,
      sessionId,
      isolate: false,
      config: config.worktree,
    });
    return { workspace, owned: false };
  }

  /**
   * Trae de vuelta una sesión dormida: carga su transcript del disco y re-attachea
   * su workspace (el worktree ya existe). Si ya está viva, devuelve la viva. null
   * si no está ni viva ni en el índice.
   */
  async revive(id: string): Promise<SessionHandle | null> {
    const live = this.#sessions.get(id);
    if (live) return live;

    const entry = this.#index.get(id);
    if (!entry) return null;

    const { config } = this.#base;
    // Session con id explícito → el constructor carga el .json si existe.
    const session = new Session({
      id: entry.id,
      dir: this.#sessionsDir,
      maxContextTokens: config.maxContextTokens,
      model: config.model,
    });

    // El worktree pudo haber sido borrado por afuera (tree.sh, rm). Si el cwd ya no
    // existe, revivimos en modo compartido para que la sesión al menos abra.
    let isolated = entry.isolated;
    let cwd = entry.cwd;
    if (isolated && !existsSync(cwd)) {
      logger.warn("worktree de la sesión ya no existe; revivo en cwd compartido", {
        id, cwd,
      });
      isolated = false;
      cwd = this.#baseDir;
    }

    const workspace = attachWorkspace({
      baseDir: this.#baseDir,
      cwd,
      isolated,
      branch: isolated ? entry.branch : undefined,
      owned: entry.owned,
      config: config.worktree,
    });

    const handle = this.#spawn(session, workspace, entry.title, entry.project);
    this.#index.touch(id, now());
    logger.info("sesión revivida", { id, cwd: workspace.cwd });
    return handle;
  }

  /** Arma el stack (tools/frontend/runner), el handle y arranca el loop. */
  #spawn(session: Session, workspace: Workspace, title: string, project: string): SessionHandle {
    const { config } = this.#base;
    const { toolRegistry, agentConfig } = createAgentStack(workspace.cwd, this.#shared);

    const frontend = new WebFrontend({
      model: config.model,
      sessionId: session.id,
      getMessages: () => session.messages,
    });
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
    const perSessionCore: CoreServices = { ...this.#base, session, agentConfig, toolRegistry };
    const turnRunner = new TurnRunner(perSessionCore, ctx, frontend);

    const handle: SessionHandle = {
      id: session.id,
      title,
      project,
      frontend,
      workspace,
      session,
      toolRegistry,
    };
    this.#sessions.set(handle.id, handle);

    frontend.start();
    this.#loops.set(handle.id, this.#runLoop(handle, turnRunner));
    return handle;
  }

  get(id: string): SessionHandle | undefined {
    return this.#sessions.get(id);
  }

  has(id: string): boolean {
    return this.#sessions.has(id);
  }

  /** ¿Está registrada (viva o dormida)? */
  knows(id: string): boolean {
    return this.#sessions.has(id) || this.#index.get(id) !== undefined;
  }

  /** cwd de una sesión (viva o dormida), para revelarla en el explorador. */
  cwdOf(id: string): string | undefined {
    return this.#sessions.get(id)?.workspace.cwd ?? this.#index.get(id)?.cwd;
  }

  /**
   * Reconciliación: escanea el store de transcripts y re-importa al índice los que
   * no estén (recupera si el índice se pierde/corrompe — el filesystem es la
   * verdad). El workspace original no se recupera (no está en el transcript): el
   * huérfano vuelve como compartido bajo el proyecto actual. Devuelve cuántos importó.
   */
  async rescan(): Promise<number> {
    let files: string[];
    try {
      files = readdirSync(this.#sessionsDir).filter((f) => f.endsWith(".json"));
    } catch {
      return 0;
    }
    const project = await detectProject(this.#baseDir);
    let imported = 0;
    for (const f of files) {
      const id = f.replace(/\.json$/, "");
      if (this.#sessions.has(id) || this.#index.get(id)) continue;
      let title = id.slice(0, 8);
      try {
        const data = JSON.parse(readFileSync(join(this.#sessionsDir, f), "utf-8"));
        if (typeof data.name === "string" && data.name.trim()) {
          title = data.name.trim();
        } else {
          const firstUser = (data.messages ?? []).find((m: { role?: string }) => m.role === "user");
          const c = firstUser?.content;
          if (typeof c === "string" && c.trim()) title = c.trim().slice(0, 40);
        }
      } catch {
        continue; // .json ilegible: lo salteamos
      }
      const ts = now();
      this.#index.upsert({
        id,
        title,
        project,
        sessionFile: this.#sessionFile(id),
        cwd: this.#baseDir,
        isolated: false,
        owned: false,
        createdAt: ts,
        lastActive: ts,
      });
      imported++;
    }
    if (imported > 0) logger.info("rescan importó sesiones huérfanas", { imported });
    return imported;
  }

  /** Solo las vivas (para usos internos). */
  liveList(): SessionInfo[] {
    return [...this.#sessions.values()].map((h) => this.#liveInfo(h));
  }

  /** Vivas + dormidas de TODOS los proyectos, más recientes primero. Es lo que ve
   *  el sidebar del daemon global. */
  listAll(): SessionInfo[] {
    const live = new Map(this.#sessions.entries());
    const infos: SessionInfo[] = [...live.values()].map((h) => this.#liveInfo(h));
    for (const e of this.#index.all()) {
      if (live.has(e.id)) continue; // ya la contamos como viva
      infos.push({
        id: e.id,
        title: e.title,
        cwd: e.cwd,
        project: e.project,
        isolated: e.isolated,
        branch: e.branch,
        clients: 0,
        live: false,
        lastActive: e.lastActive,
      });
    }
    // vivas primero, después dormidas por lastActive desc
    return infos.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return (b.lastActive ?? 0) - (a.lastActive ?? 0);
    });
  }

  #liveInfo(h: SessionHandle): SessionInfo {
    return {
      id: h.id,
      title: h.title,
      cwd: h.workspace.cwd,
      project: h.project,
      isolated: h.workspace.isolated,
      branch: h.workspace.branch,
      clients: h.frontend.clientCount,
      live: true,
      status: h.frontend.status,
      lastActive: this.#index.get(h.id)?.lastActive,
    };
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
        this.#index.touch(handle.id, now(), handle.title);
      }
    } catch (err: unknown) {
      logger.error("loop de sesión murió", {
        id: handle.id,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.#cleanup(handle);
    }
  }

  /**
   * Baja el LOOP de una sesión y la deja DORMIDA: para el runtime, pero NO destruye
   * su workspace ni su transcript (siguen en disco, revivibles). Es lo que corre el
   * shutdown y el "cerrar" del sidebar. Nada se borra por sorpresa.
   */
  async detach(id: string): Promise<void> {
    const handle = this.#sessions.get(id);
    if (!handle) return;
    handle.frontend.submitInput("/exit"); // desbloquea el loop parado en nextInput
    await this.#loops.get(id);
  }

  /** Baja todas las sesiones vivas (shutdown). No destruye workspaces. */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.detach(id)));
  }

  /** Limpia el runtime de una sesión (sin tocar disco). Lo llama el finally del loop. */
  #cleanup(handle: SessionHandle): void {
    if (!this.#sessions.delete(handle.id)) return; // ya limpiada
    this.#loops.delete(handle.id);
    this.#index.touch(handle.id, now(), handle.title);
    handle.frontend.stop();
    // Cierra procesos MCP hijos que ESTA sesión haya arrancado (registry propio).
    try {
      handle.toolRegistry.disconnectAll();
    } catch {
      /* best-effort */
    }
    logger.info("sesión dormida", { id: handle.id });
  }
}
