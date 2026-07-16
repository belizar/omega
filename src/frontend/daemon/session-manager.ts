import { randomUUID } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { Context } from "../../app-context.js";
import { CoreServices, createAgentStack, SharedAgentDeps } from "../../core.js";
import { logger } from "../../logger.js";
import { Session } from "../../session.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { TurnRunner } from "../../turn-runner.js";
import { Screen } from "../../tui/screen.js";
import {
  attachWorkspace,
  createWorkspace,
  detectBranch,
  detectProject,
  Workspace,
} from "../../workspace.js";
import { SessionIndex } from "./session-index.js";
import { LifecycleEvent, SessionStatus, WebFrontend } from "../frontends/web-frontend.js";
import { NotificationHub, NotifSink } from "./notification-hub.js";
import { HookRunner } from "../../hooks.js";

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
  /** Archivada: escondida del sidebar por default (no borrada). */
  archived: boolean;
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
  /** Hub GLOBAL de atención (todas las sesiones → una SSE). */
  #notifHub: NotificationHub;
  /** Hooks de shell del usuario (fire-and-forget). Vacío por default (tests). */
  #hooks: HookRunner;

  constructor(
    base: CoreServices,
    opts: {
      baseDir: string;
      sessionsDir?: string;
      index?: SessionIndex;
      notifHub?: NotificationHub;
      hooks?: HookRunner;
    },
  ) {
    this.#base = base;
    this.#baseDir = opts.baseDir;
    // Store GLOBAL (daemon): los transcripts viven en ~/.omega/sessions,
    // independientes del proyecto → revivir cross-project es trivial. Inyectable
    // para tests. El `project` es solo para agrupar, no dónde se guarda.
    this.#sessionsDir = opts.sessionsDir ?? join(homedir(), ".omega", "sessions");
    this.#index = opts.index ?? new SessionIndex();
    this.#notifHub = opts.notifHub ?? new NotificationHub();
    // HookRunner vacío por default (no lee disco): serve-mode inyecta el cargado
    // de ~/.omega/hooks.json. Así los tests quedan herméticos.
    this.#hooks = opts.hooks ?? new HookRunner();
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
      // El repo donde crear el worktree: el elegido (opts.cwd), o el baseDir del
      // daemon. En el modelo multi-proyecto el daemon corre sobre ~/Workspace (no
      // es repo), así que sin repo elegido caería a compartido — por eso el picker.
      const repoDir = opts.cwd ? resolve(opts.cwd) : this.#baseDir;
      const workspace = await createWorkspace({
        baseDir: repoDir,
        sessionId,
        isolate: true,
        branch: opts.branch,
        base: opts.base,
        config: config.worktree,
      });
      // createWorkspace cae a compartido si repoDir no es repo git → owned solo si aisló.
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
    // Session con id explícito → el constructor carga el .json si existe. Usamos
    // el dir REAL del transcript (dirname del sessionFile del índice), no el store
    // global: así revive tanto las sesiones del daemon como las importadas de tus
    // worktrees (que viven en <worktree>/.omega/sessions).
    const session = new Session({
      id: entry.id,
      dir: dirname(entry.sessionFile),
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
      onLifecycle: (ev) => this.#dispatchLifecycle(session.id, ev),
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
   * Reconciliación del store global: re-importa transcripts huérfanos del índice
   * (recupera si el índice se pierde). El filesystem es la verdad.
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
      const sessionFile = join(this.#sessionsDir, f);
      if (!existsSync(sessionFile)) continue;
      const ts = now();
      this.#index.upsert({
        id,
        title: this.#titleFrom(sessionFile) || id.slice(0, 8),
        project,
        sessionFile,
        cwd: this.#baseDir,
        isolated: false,
        owned: false,
        createdAt: ts,
        lastActive: ts,
      });
      imported++;
    }
    if (imported > 0) logger.info("rescan importó huérfanos del store global", { imported });
    return imported;
  }

  /**
   * Onboarding: escanea `roots` buscando sesiones existentes en
   * `<worktree>/.omega/sessions/*.json` (las que crea la TUI in-process, por
   * worktree) y las importa al índice con su cwd y proyecto REALES. Es lo que
   * trae tu laburo previo al mission-control. No mueve ni toca nada: solo agrega
   * referencias (el transcript sigue donde estaba). Devuelve cuántas importó.
   */
  async importExisting(roots: string[]): Promise<number> {
    const dirs = new Set<string>();
    for (const root of roots) {
      for (const d of this.#findSessionDirs(root, 4)) dirs.add(d);
    }
    let imported = 0;
    for (const wt of dirs) {
      const sdir = join(wt, ".omega", "sessions");
      let files: string[];
      try {
        files = readdirSync(sdir).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }
      if (files.length === 0) continue;
      const project = await detectProject(wt);
      const branch = await detectBranch(wt);
      const isolated = resolve(wt) !== resolve(this.#baseDir);
      for (const f of files) {
        const id = f.replace(/\.json$/, "");
        if (this.#sessions.has(id) || this.#index.get(id)) continue;
        const sessionFile = join(sdir, f);
        // Título útil para TU flujo: el nombre explícito, o la branch (feat/MED-x),
        // o el primer mensaje, o el id. La branch primero porque tus sesiones son
        // por-ticket y "feat/MED-1400" dice más que el primer mensaje.
        const title = this.#titleFrom(sessionFile, { preferBranch: branch }) || id.slice(0, 8);
        let lastActive = now();
        try {
          lastActive = Math.floor(statSync(sessionFile).mtimeMs);
        } catch {
          /* sin mtime: queda now() */
        }
        this.#index.upsert({
          id,
          title,
          project,
          sessionFile,
          cwd: wt,
          branch,
          isolated,
          owned: false, // son TUS worktrees; Omega no los creó ni los borra
          createdAt: lastActive,
          lastActive,
        });
        imported++;
      }
    }
    if (imported > 0) {
      logger.info("importadas sesiones existentes de worktrees", { imported, dirs: dirs.size });
    }
    return imported;
  }

  /** Busca dirs con `.omega/sessions` bajo `root` (acotado, sin node_modules/.git). */
  #findSessionDirs(root: string, maxDepth: number): string[] {
    const found: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > maxDepth) return;
      let entries: import("fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name === "node_modules" || e.name === ".git" || e.name.endsWith(".git")) continue;
        if (e.name === ".omega") {
          if (existsSync(join(dir, ".omega", "sessions"))) found.push(dir);
          continue; // no recursamos dentro de .omega
        }
        walk(join(dir, e.name), depth + 1);
      }
    };
    walk(root, 0);
    return found;
  }

  /** Extrae un título del transcript: nombre explícito → (branch si se prefiere) →
   *  primer mensaje del usuario. "" si no encuentra nada usable. */
  #titleFrom(path: string, opts?: { preferBranch?: string }): string {
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      if (typeof data.name === "string" && data.name.trim()) return data.name.trim();
      if (opts?.preferBranch) return opts.preferBranch;
      const firstUser = (data.messages ?? []).find((m: { role?: string }) => m.role === "user");
      const c = firstUser?.content;
      if (typeof c === "string" && c.trim()) return c.trim().slice(0, 40);
    } catch {
      /* .json ilegible */
    }
    return "";
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
        archived: !!e.archived,
      });
    }
    // Orden ESTABLE: manual (`order`) si lo hay, si no por createdAt (creación).
    // NO por live/lastActive → seleccionar una sesión no la mueve de lugar; su
    // estado se comunica por color, no por posición.
    const key = (s: SessionInfo): number => {
      const e = this.#index.get(s.id);
      return e?.order ?? e?.createdAt ?? 0;
    };
    return infos.sort((a, b) => key(a) - key(b));
  }

  /** Reordena el sidebar (drag-and-drop): persiste el nuevo orden de los ids. */
  reorder(ids: string[]): void {
    this.#index.reorder(ids);
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
      archived: !!this.#index.get(h.id)?.archived,
    };
  }

  // ── Notificaciones + hooks ────────────────────────────────────────

  /** Suscribe un cliente al hub GLOBAL de atención (SSE `/events/all`). */
  addNotificationClient(sink: NotifSink): () => void {
    return this.#notifHub.add(sink);
  }

  /**
   * Un evento de ciclo de vida de UNA sesión llegó (desde su WebFrontend). Lo
   * enriquecemos con la metadata del workspace (título/proyecto/cwd — que el
   * frontend no conoce) y lo despachamos a los DOS consumidores:
   *  - el hub de notificaciones (para el browser: solo atención = ask/turn-end).
   *  - los hooks de shell del usuario (todos los eventos; ellos filtran).
   */
  #dispatchLifecycle(sessionId: string, ev: LifecycleEvent): void {
    const h = this.#sessions.get(sessionId);
    const entry = this.#index.get(sessionId);
    const title = h?.title ?? entry?.title ?? sessionId.slice(0, 8);
    const cwd = h?.workspace.cwd ?? entry?.cwd ?? "";
    const project = h?.project ?? entry?.project ?? "";

    // Notificaciones al browser: solo los eventos de ATENCIÓN.
    if (ev.kind === "ask-user" || ev.kind === "turn-end") {
      this.#notifHub.emit({
        type: "attention",
        sessionId,
        kind: ev.kind === "ask-user" ? "ask_user" : "turn_end",
        title,
        project,
        cwd,
        question: ev.kind === "ask-user" ? ev.question : undefined,
        ts: now(),
      });
    }

    // Hooks de shell: todos los eventos (si no hay hooks.json, es un no-op barato).
    if (!this.#hooks.isEmpty) {
      const payload: Record<string, unknown> = { sessionId, cwd, project, title };
      if (ev.kind === "ask-user") payload.question = ev.question;
      this.#hooks.fire(ev.kind, payload);
    }
  }

  /**
   * Renombra una sesión (viva o dormida). Si está viva, actualiza el handle y
   * persiste el nombre en el transcript (`session.rename`). Si está dormida, toca
   * el índice y —para que un rescan futuro no revierta el nombre— parchea el campo
   * `name` del `.json` en disco. Devuelve el título final, o null si no existe.
   */
  rename(id: string, rawTitle: string): string | null {
    const title = rawTitle.trim().slice(0, 80);
    if (!title) return null;

    const live = this.#sessions.get(id);
    if (live) {
      live.title = title;
      live.session.rename(title); // persiste al .json + índice vía touch abajo
      this.#index.rename(id, title);
      return title;
    }

    const entry = this.#index.get(id);
    if (!entry) return null;
    this.#index.rename(id, title);
    // El transcript es la verdad para el título en rescans: parcheamos su `name`.
    this.#patchSessionName(entry.sessionFile, title);
    return title;
  }

  /** Archiva/desarchiva una sesión (viva o dormida): solo toca el índice. */
  setArchived(id: string, archived: boolean): boolean {
    if (!this.#index.get(id)) return false;
    this.#index.setArchived(id, archived);
    return true;
  }

  /** Read-modify-write acotado del `name` en un transcript dormido. Sin loop
   *  corriendo (dormida) no hay escritor concurrente, así que es seguro. */
  #patchSessionName(sessionFile: string, name: string): void {
    try {
      const data = JSON.parse(readFileSync(sessionFile, "utf-8"));
      data.name = name;
      writeFileSync(sessionFile, JSON.stringify(data, null, 2), "utf-8");
    } catch {
      /* .json ilegible o ausente: el índice ya quedó actualizado igual */
    }
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
