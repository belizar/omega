import { execFile } from "child_process";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { promisify } from "util";
import { CoreServices } from "../core.js";
import { logger } from "../logger.js";
import { CreateSessionOpts, SessionHandle, SessionManager, SessionMode } from "./session-manager.js";
import { WEB_CLIENT_HTML } from "./web-client.js";
import type { FrontendMode } from "./mode.js";

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

  constructor(core: CoreServices, port: number) {
    this.#core = core;
    this.#port = port;
  }

  async run(): Promise<void> {
    this.#baseDir = process.cwd();
    const manager = new SessionManager(this.#core, { baseDir: this.#baseDir });
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

    // 127.0.0.1 a propósito: NO 0.0.0.0. El agente corre bash/edit.
    await new Promise<void>((resolve) => {
      server.listen(this.#port, "127.0.0.1", () => resolve());
    });
    const url = `http://localhost:${this.#port}`;
    process.stderr.write(`\n  Ω omega serve  →  ${url}\n  (Ctrl+C para cortar)\n\n`);
    logger.info("web server up (multi-sesión)", { url, default: this.#defaultId });

    // Shutdown ordenado: DORMIMOS las sesiones (para los loops) — NO destruimos
    // workspaces ni transcripts. Al reiniciar el server se rehidratan del índice.
    const shutdown = async (): Promise<void> => {
      logger.info("serve shutdown");
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
          await m.detach(sessionId);
          res.writeHead(204).end();
        } },
      { method: "GET", path: "/worktrees", handler: async ({ res }) =>
          this.#json(res, 200, { worktrees: await this.#listWorktrees() }) },
      { method: "POST", path: "/rescan", handler: async ({ res }) =>
          this.#json(res, 200, { imported: await m.rescan() }) },
      { method: "POST", path: "/reveal", handler: ({ res, sessionId }) => {
          // cwdOf (no revive): anda para vivas y dormidas. Solo abre un cwd conocido.
          const cwd = m.cwdOf(sessionId);
          if (!cwd) return this.#json(res, 404, { error: `sesión ${sessionId} desconocida` });
          this.#openInExplorer(cwd);
          res.writeHead(204).end();
        } },
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

  // ── Helpers ─────────────────────────────────────────────────────────

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
