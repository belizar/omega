import { execFile } from "child_process";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { Duplex } from "stream";
import { promisify } from "util";
import { WebSocket, WebSocketServer } from "ws";
import { CoreServices } from "../../core.js";
import { logger } from "../../logger.js";
import { CreateSessionOpts, SessionHandle, SessionManager, SessionMode } from "./session-manager.js";
import { DaemonClient } from "../client/daemon-client.js";
import { writeDaemonInfo, clearDaemonInfo } from "./daemon-info.js";
import { WEB_CLIENT_HTML } from "../frontends/web-client.js";
import { HookRunner } from "../../hooks.js";
import { computeDiff } from "../workspace/diff.js";
import { listDir, readFileContent } from "../workspace/files.js";
import { generateReview } from "../workspace/review.js";
import { TerminalManager } from "./terminal-manager.js";
import type { FrontendMode } from "../modes/mode.js";

const execFileAsync = promisify(execFile);

/** Lo que recibe cada handler de ruta: request, response, query y —si la ruta lo
 *  pide— la sesión ya resuelta. */
interface RouteCtx {
  req: IncomingMessage;
  res: ServerResponse;
  q: URLSearchParams;
  /** `?session=` o la default. */
  sessionId: string;
  /** La sesión viva, resuelta si `revive: true` (revivida on-demand si dormía). */
  handle?: SessionHandle;
}

/** Una ruta declarativa. `revive` resuelve la sesión (get-or-revive) antes del
 *  handler y responde 404 si no existe — así los endpoints no lo repiten. */
interface Route {
  method: string;
  path: string;
  revive?: boolean;
  handler: (ctx: RouteCtx) => void | Promise<void>;
}

/**
 * Modo `serve`: hostea el core detrás de un server HTTP, manejable desde un
 * browser (o desde la TUI cliente vía `omega mc`). Multi-sesión: monta un
 * `SessionManager` que hospeda N sesiones concurrentes, cada una con su hub SSE,
 * su workspace y su loop. Transporte cero-dep sobre `http` nativo, ruteo por una
 * tabla declarativa (ver `#routes`).
 *
 * Atado a 127.0.0.1: el agente corre bash/edit; exponerlo sin auth sería un
 * agujero. Auth + multi-tenancy son la capa de nube, no el MVP.
 */
export class ServeMode implements FrontendMode {
  #core: CoreServices;
  #port: number;
  #manager!: SessionManager;
  #defaultId = "";
  #baseDir = "";
  #routes: Route[] = [];
  /** PTYs interactivos por sesión (tab Terminal). Persistentes tipo tmux. */
  #terminals = new TerminalManager();
  /** WS server sin listener propio: engancha el `upgrade` del server http. */
  #wss = new WebSocketServer({ noServer: true });

  constructor(core: CoreServices, port: number) {
    this.#core = core;
    this.#port = port;
  }

  async run(): Promise<void> {
    this.#baseDir = process.cwd();

    // Guard de colisión: si YA hay un daemon respondiendo en este puerto, no
    // arrancamos un segundo (chocaría con EADDRINUSE y encima pisaría el registro).
    // El cliente (`omega mc`) hace ping antes de spawnnear, pero un `omega serve`
    // manual podría chocar igual — lo atajamos acá con un mensaje claro.
    if (await new DaemonClient(this.#port).ping()) {
      process.stderr.write(
        `\n  Ω ya hay un daemon en :${this.#port} — usá 'omega mc' o 'omega serve status'.\n\n`,
      );
      return;
    }

    // Hooks del usuario (~/.omega/hooks.json): notificaciones de atención,
    // formateo post-tool, etc. Vacío si no hay archivo. Fire-and-forget.
    const hooks = HookRunner.load();
    if (!hooks.isEmpty) logger.info("hooks cargados de ~/.omega/hooks.json");
    const manager = new SessionManager(this.#core, { baseDir: this.#baseDir, hooks });
    this.#manager = manager;
    this.#routes = this.#buildRoutes(manager);

    // Arranque sin amnesia: si el índice ya tiene sesiones, revivo la más reciente
    // como default (te devuelve donde estabas). Si no hay ninguna, creo la
    // "principal" (comparte cwd — la UX single-sesión de siempre).
    const dormant = manager.listAll();
    if (dormant.length > 0) {
      const revived = await manager.revive(dormant[0].id);
      this.#defaultId = revived ? revived.id : (await manager.create({ title: "principal" })).id;
      logger.info("sesiones dormidas encontradas", { total: dormant.length, revived: this.#defaultId });
    } else {
      this.#defaultId = (await manager.create({ title: "principal" })).id;
    }

    const server = createServer((req, res) => {
      // El dispatch puede ser async; atrapamos para no tirar el server.
      Promise.resolve(this.#handle(req, res)).catch((err) => {
        logger.error("serve handler error", { err: String(err) });
        if (!res.headersSent) res.writeHead(500).end();
      });
    });

    // WebSocket para la tab Terminal: SSE+POST no sirve (cada tecla por POST
    // metería latencia). El PTY lo spawnea el DAEMON en el cwd del workspace y se
    // streamea bidireccional. Enganchamos el `upgrade` del mismo server http.
    server.on("upgrade", (req, socket, head) => this.#handleUpgrade(req, socket, head));

    // 127.0.0.1 a propósito: NO 0.0.0.0. El agente corre bash/edit.
    await new Promise<void>((resolve) => {
      server.listen(this.#port, "127.0.0.1", () => resolve());
    });
    const url = `http://localhost:${this.#port}`;
    process.stderr.write(`\n  Ω omega serve  →  ${url}\n  (Ctrl+C para cortar · 'omega serve stop' desde otra terminal)\n\n`);
    logger.info("web server up (multi-sesión)", { url, default: this.#defaultId });

    // Registro de sí mismo: así 'omega serve stop/status' desde OTRA terminal puede
    // encontrar a este proceso (que corre detached). Guardamos también el bin/cwd
    // para diagnosticar el "dead-dist" (un daemon sirviendo un build ya borrado).
    writeDaemonInfo({
      pid: process.pid,
      port: this.#port,
      cwd: this.#baseDir,
      bin: process.argv[1] ?? "",
      startedAt: Date.now(),
    });

    // Onboarding EN BACKGROUND: descubrir tus sesiones existentes (las de la TUI,
    // por worktree) escaneando el cwd de arranque + los `projects` configurados.
    // No bloquea el arranque (escanear muchos worktrees puede tardar); aparecen en
    // el sidebar vía el poll del cliente a medida que se importan.
    void manager.importExisting(this.#scanRoots()).then((n) => {
      if (n > 0) logger.info("onboarding: sesiones existentes importadas", { imported: n });
    });

    // Shutdown ordenado: DORMIMOS las sesiones (para los loops) — NO destruimos
    // workspaces ni transcripts. Al reiniciar el server se rehidratan del índice.
    const shutdown = async (): Promise<void> => {
      logger.info("serve shutdown");
      clearDaemonInfo(); // borramos el registro: ya no hay daemon que encontrar.
      this.#terminals.killAll(); // no dejar shells huérfanas
      await manager.disposeAll();
      server.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Mantener run() pendiente: los loops viven en el manager; el proceso se
    // sostiene con el server escuchando.
    await new Promise<void>((resolve) => server.on("close", () => resolve()));
  }

  // ── Ruteo ───────────────────────────────────────────────────────────

  /** La tabla de rutas. Cada endpoint queda declarativo; el get-or-revive de la
   *  sesión y el 404 los resuelve el dispatcher (flag `revive`). */
  #buildRoutes(m: SessionManager): Route[] {
    return [
      { method: "GET", path: "/", handler: ({ res }) => this.#serveClient(res) },
      { method: "GET", path: "/sessions", handler: ({ res }) =>
          this.#json(res, 200, { sessions: m.listAll(), default: this.#defaultId }) },
      { method: "POST", path: "/sessions", handler: (c) => this.#createSession(c, m) },
      { method: "DELETE", path: "/sessions", handler: async ({ res, sessionId }) => {
          // Dormir (detach): para el loop, NO destruye nada. Cerrar ≠ borrar.
          // El PTY sí se mata: es proceso vivo, no estado rehidratable (tmux-like
          // pero atado a la sesión — al cerrarla, la shell se va).
          this.#terminals.kill(sessionId);
          await m.detach(sessionId);
          res.writeHead(204).end();
        } },
      { method: "PATCH", path: "/sessions", handler: async ({ req, res, sessionId }) => {
          // Renombrar (viva o dormida). No revive: opera sobre el índice / el handle.
          const body = await this.#readBody(req);
          let title = "";
          try { title = String(JSON.parse(body || "{}").title ?? ""); } catch { return void res.writeHead(400).end(); }
          const applied = m.rename(sessionId, title);
          if (applied === null) return this.#json(res, 400, { error: "título vacío o sesión desconocida" });
          this.#json(res, 200, { id: sessionId, title: applied });
        } },
      { method: "POST", path: "/reorder", handler: async ({ req, res }) => {
          // Reordenar el sidebar (drag). Body { ids: [...] } en el orden nuevo.
          const body = await this.#readBody(req);
          try {
            const ids = JSON.parse(body || "{}").ids;
            if (!Array.isArray(ids)) return void res.writeHead(400).end();
            m.reorder(ids.filter((x: unknown): x is string => typeof x === "string"));
            res.writeHead(204).end();
          } catch {
            res.writeHead(400).end();
          }
        } },
      { method: "POST", path: "/archive", handler: async ({ req, res, sessionId }) => {
          // Archivar/desarchivar: escondida del sidebar, NO borrada. Body {archived}.
          const body = await this.#readBody(req);
          let archived = true;
          try { archived = JSON.parse(body || "{}").archived !== false; } catch { /* default archivar */ }
          if (!m.setArchived(sessionId, archived)) return this.#json(res, 404, { error: `sesión ${sessionId} desconocida` });
          res.writeHead(204).end();
        } },
      { method: "GET", path: "/worktrees", handler: async ({ res }) =>
          this.#json(res, 200, { worktrees: await this.#listWorktrees() }) },
      { method: "POST", path: "/rescan", handler: async ({ res }) => {
          // Onboarding (worktrees) + reconciliación del store global.
          const fromWorktrees = await m.importExisting(this.#scanRoots());
          const orphans = await m.rescan();
          this.#json(res, 200, { imported: fromWorktrees + orphans });
        } },
      { method: "GET", path: "/diff", handler: async ({ res, sessionId, q }) => {
          // Diff del workspace de la sesión. Fuente: sin `base` = cambios sin
          // commitear (lo que tocó el agente); `?base=main` = una branch/PR.
          // cwdOf (no revive): anda para vivas y dormidas.
          const cwd = m.cwdOf(sessionId);
          if (!cwd) return this.#json(res, 404, { error: `sesión ${sessionId} desconocida` });
          const base = q.get("base")?.trim() || undefined;
          try {
            this.#json(res, 200, await computeDiff(cwd, base));
          } catch (err) {
            this.#json(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        } },
      { method: "POST", path: "/review", revive: true, handler: async ({ res, q, handle }) => {
          // Review guiado: computa el diff y le pide al LLM la guía estructurada.
          // Una llamada enfocada (sin tools, sin loop). Puede tardar unos segundos.
          // revive:true → tenemos el frontend vivo para marcar la sesión "ocupada"
          // (el sidebar la muestra corriendo, y avisa al terminar).
          const base = q.get("base")?.trim() || undefined;
          handle!.frontend.beginBackgroundTask();
          try {
            const diff = await computeDiff(handle!.workspace.cwd, base);
            const guide = await generateReview(diff, this.#core.llmProvider, {
              model: this.#core.config.model,
              maxTokens: this.#core.config.maxTokens,
            });
            this.#json(res, 200, guide);
          } catch (err) {
            this.#json(res, 500, { error: err instanceof Error ? err.message : String(err) });
          } finally {
            handle!.frontend.endBackgroundTask();
          }
        } },
      { method: "GET", path: "/files", handler: ({ res, sessionId, q }) => {
          // Listar un directorio del workspace. `?path=` relativo al cwd (safe).
          const cwd = m.cwdOf(sessionId);
          if (!cwd) return this.#json(res, 404, { error: `sesión ${sessionId} desconocida` });
          try {
            this.#json(res, 200, listDir(cwd, q.get("path") ?? ""));
          } catch (err) {
            this.#json(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        } },
      { method: "GET", path: "/file", handler: ({ res, sessionId, q }) => {
          // Leer un archivo del workspace. `?path=` relativo al cwd (safe).
          const cwd = m.cwdOf(sessionId);
          if (!cwd) return this.#json(res, 404, { error: `sesión ${sessionId} desconocida` });
          const path = q.get("path");
          if (!path) return this.#json(res, 400, { error: "falta ?path=" });
          try {
            this.#json(res, 200, readFileContent(cwd, path));
          } catch (err) {
            this.#json(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        } },
      { method: "POST", path: "/reveal", handler: ({ res, sessionId }) => {
          // cwdOf (no revive): anda para vivas y dormidas. Solo abre un cwd conocido.
          const cwd = m.cwdOf(sessionId);
          if (!cwd) return this.#json(res, 404, { error: `sesión ${sessionId} desconocida` });
          this.#openInExplorer(cwd);
          res.writeHead(204).end();
        } },
      { method: "GET", path: "/events/all", handler: (c) => this.#globalEvents(c) },
      { method: "GET", path: "/events", revive: true, handler: (c) => this.#events(c) },
      { method: "POST", path: "/interrupt", revive: true, handler: ({ res, handle }) => {
          handle!.frontend.interrupt();
          res.writeHead(204).end();
        } },
      { method: "POST", path: "/input", revive: true, handler: (c) => this.#input(c) },
    ];
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname === "/index.html" ? "/" : url.pathname;

    const route = this.#routes.find((r) => r.method === method && r.path === path);
    if (!route) return void res.writeHead(404).end();

    const ctx: RouteCtx = {
      req,
      res,
      q: url.searchParams,
      sessionId: url.searchParams.get("session") ?? this.#defaultId,
    };

    // Rutas session-scoped: resolvemos la sesión (revivimos si dormía) una sola
    // vez, acá, en vez de repetirlo en cada handler.
    if (route.revive) {
      ctx.handle = this.#manager.get(ctx.sessionId) ?? (await this.#manager.revive(ctx.sessionId)) ?? undefined;
      if (!ctx.handle) return this.#json(res, 404, { error: `sesión ${ctx.sessionId} no encontrada` });
    }

    await route.handler(ctx);
  }

  // ── Handlers con lógica propia ──────────────────────────────────────

  #serveClient(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(WEB_CLIENT_HTML);
  }

  async #createSession({ req, res }: RouteCtx, m: SessionManager): Promise<void> {
    const body = await this.#readBody(req);
    let opts: CreateSessionOpts;
    try {
      const b = JSON.parse(body || "{}");
      const mode: SessionMode | undefined =
        b.mode === "shared" || b.mode === "create" || b.mode === "attach"
          ? b.mode
          : b.worktree === true
            ? "create"
            : undefined;
      opts = {
        title: typeof b.title === "string" ? b.title : undefined,
        mode,
        cwd: typeof b.cwd === "string" && b.cwd.trim() ? b.cwd.trim() : undefined,
        branch: typeof b.branch === "string" && b.branch.trim() ? b.branch.trim() : undefined,
        base: typeof b.base === "string" && b.base.trim() ? b.base.trim() : undefined,
      };
    } catch {
      return void res.writeHead(400).end();
    }
    try {
      const handle = await m.create(opts);
      this.#json(res, 201, {
        id: handle.id,
        title: handle.title,
        cwd: handle.workspace.cwd,
        isolated: handle.workspace.isolated,
        branch: handle.workspace.branch,
      });
    } catch (err) {
      // Ej: la branch ya tiene un worktree, o el path ya existe.
      this.#json(res, 409, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  #events({ req, res, handle }: RouteCtx): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const unsub = handle!.frontend.addClient((data) => res.write(`data: ${data}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      unsub();
    });
  }

  /** SSE GLOBAL: los eventos de atención de TODAS las sesiones, en una conexión.
   *  Es lo que le permite al browser notificar por un workspace que no estás
   *  mirando (a diferencia de `/events`, que es de la sesión activa). */
  #globalEvents({ req, res }: RouteCtx): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const unsub = this.#manager.addNotificationClient((data) => res.write(`data: ${data}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      unsub();
    });
  }

  async #input({ req, res, handle }: RouteCtx): Promise<void> {
    const body = await this.#readBody(req);
    try {
      const { text } = JSON.parse(body || "{}");
      if (typeof text === "string" && text.length > 0) {
        handle!.frontend.submitInput(text);
      }
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
  }

  // ── Terminal (WebSocket) ────────────────────────────────────────────

  /** Handshake WS de la tab Terminal: `GET /terminal?session=<id>` con upgrade.
   *  Resuelve el cwd sin revivir (anda para vivas y dormidas); si no existe,
   *  cortamos el socket. El PTY se crea/reusa en el puente. */
  #handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/terminal") {
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get("session") ?? this.#defaultId;
    const cwd = this.#manager.cwdOf(sessionId);
    if (!cwd) {
      socket.destroy();
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#bridgeTerminal(ws, sessionId, cwd));
  }

  /** Puente WS ⇄ PTY. Al conectar: replay del scrollback (reconexión tipo tmux).
   *  Bidireccional: onData del PTY → WS; mensajes del cliente → write/resize. El
   *  cierre del WS NO mata el PTY (persistente) — solo baja el refcount. */
  #bridgeTerminal(ws: WebSocket, sessionId: string, cwd: string): void {
    const term = this.#terminals.getOrCreate(sessionId, cwd);
    this.#terminals.attach(sessionId);

    // Replay: el cliente ve dónde quedó (su neovim, sus logs) al reconectar.
    if (term.replay) ws.send(JSON.stringify({ t: "data", d: term.replay }));

    const offData = term.onData((d) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "data", d }));
    });
    const offExit = term.onExit(() => {
      try { ws.close(); } catch { /* ya cerrado */ }
    });

    ws.on("message", (raw) => {
      let msg: { t?: string; d?: string; cols?: number; rows?: number };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === "data" && typeof msg.d === "string") term.write(msg.d);
      else if (msg.t === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
        term.resize(msg.cols, msg.rows);
      }
    });

    ws.on("close", () => {
      offData();
      offExit();
      this.#terminals.detach(sessionId);
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /** Raíces a escanear en busca de sesiones existentes: el cwd de arranque + los
   *  `projects` de ~/.omega/config.json. */
  #scanRoots(): string[] {
    return [this.#baseDir, ...this.#core.config.projects];
  }

  #readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => resolve(body));
    });
  }

  #json(res: ServerResponse, status: number, obj: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  }

  /** Lista los git worktrees del repo (para sugerir en el modo attach). Excluye
   *  el bare y el propio baseDir del server. Vacío si no es repo git. */
  async #listWorktrees(): Promise<Array<{ path: string; branch?: string }>> {
    try {
      const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
        cwd: this.#baseDir,
      });
      const out: Array<{ path: string; branch?: string }> = [];
      let cur: { path: string; branch?: string } | null = null;
      for (const line of stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
          cur = { path: line.slice("worktree ".length).trim() };
          out.push(cur);
        } else if (line.startsWith("branch ") && cur) {
          cur.branch = line.slice("branch refs/heads/".length).trim();
        }
      }
      return out.filter((w) => w.path && w.path !== this.#baseDir);
    } catch {
      return [];
    }
  }

  /** Abre un directorio en el explorador del SO (best-effort). */
  #openInExplorer(cwd: string): void {
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open";
    execFile(cmd, [cwd], () => {
      /* best-effort: si falla, no rompemos el server */
    });
  }
}
