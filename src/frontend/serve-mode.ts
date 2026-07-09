import { createServer, IncomingMessage, ServerResponse } from "http";
import { CoreServices } from "../core.js";
import { logger } from "../logger.js";
import { SessionManager } from "./session-manager.js";
import { WEB_CLIENT_HTML } from "./web-client.js";
import type { FrontendMode } from "./mode.js";

/**
 * Modo `serve`: hostea el core detrás de un server HTTP, manejable desde un
 * browser. Multi-sesión: el server monta un `SessionManager` que hospeda N
 * sesiones de agente concurrentes, cada una con su hub SSE, su workspace y su
 * loop. El transporte sigue siendo cero-dep sobre `http` nativo.
 *
 * Rutas (session-scoped por `?session=<id>`; sin el query, cae a la default):
 *   GET    /              → el cliente (SPA vanilla)
 *   GET    /sessions      → lista de sesiones vivas (JSON)
 *   POST   /sessions      → crea una sesión ({title?, worktree?}) → su info
 *   DELETE /sessions      → baja la sesión ?session=<id>
 *   GET    /events        → SSE de la sesión
 *   POST   /input         → mensaje → cola de la sesión
 *   POST   /interrupt     → corta el turno en curso de la sesión
 *
 * Atado a 127.0.0.1: el agente corre bash/edit; exponerlo sin auth sería un
 * agujero. Auth + multi-tenancy son la capa de nube, no el MVP.
 */
export class ServeMode implements FrontendMode {
  #core: CoreServices;
  #port: number;
  #manager: SessionManager | null = null;
  #defaultId = "";

  constructor(core: CoreServices, port: number) {
    this.#core = core;
    this.#port = port;
  }

  async run(): Promise<void> {
    const baseDir = process.cwd();
    const manager = new SessionManager(this.#core, { baseDir });
    this.#manager = manager;

    // Sesión por defecto: comparte el cwd del server (la UX single-sesión de
    // siempre). Sesiones nuevas pueden pedir un worktree aislado desde el sidebar.
    const first = await manager.create({ title: "principal" });
    this.#defaultId = first.id;

    const server = createServer((req, res) => {
      // El dispatch puede ser async (crear sesión); atrapamos para no tirar el server.
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
    logger.info("web server up (multi-sesión)", { url, default: first.id });

    // Shutdown ordenado: baja todas las sesiones (limpia worktrees) y cierra.
    const shutdown = async (): Promise<void> => {
      logger.info("serve shutdown");
      await manager.disposeAll();
      server.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Mantener run() pendiente: los loops de sesión viven en el manager; el
    // proceso se sostiene con el server escuchando.
    await new Promise<void>((resolve) => server.on("close", () => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const manager = this.#manager!;
    const method = req.method ?? "GET";
    const parsed = new URL(req.url ?? "/", "http://localhost");
    const path = parsed.pathname;
    const sessionId = parsed.searchParams.get("session") ?? this.#defaultId;

    // ── El cliente ──────────────────────────────────────────────────
    if (method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(WEB_CLIENT_HTML);
      return;
    }

    // ── Sesiones: listar ────────────────────────────────────────────
    if (method === "GET" && path === "/sessions") {
      this.#json(res, 200, { sessions: manager.list(), default: this.#defaultId });
      return;
    }

    // ── Sesiones: crear ─────────────────────────────────────────────
    if (method === "POST" && path === "/sessions") {
      const body = await this.#readBody(req);
      let opts: { title?: string; worktree?: boolean } = {};
      try {
        const parsedBody = JSON.parse(body || "{}");
        opts = {
          title: typeof parsedBody.title === "string" ? parsedBody.title : undefined,
          worktree: parsedBody.worktree === true,
        };
      } catch {
        res.writeHead(400).end();
        return;
      }
      const handle = await manager.create(opts);
      this.#json(res, 201, {
        id: handle.id,
        title: handle.title,
        cwd: handle.workspace.cwd,
        isolated: handle.workspace.isolated,
      });
      return;
    }

    // ── Sesiones: bajar ─────────────────────────────────────────────
    if (method === "DELETE" && path === "/sessions") {
      // No permitir bajar la última sesión: el server quedaría sin default usable.
      if (manager.list().length <= 1) {
        this.#json(res, 409, { error: "no se puede bajar la única sesión" });
        return;
      }
      await manager.remove(sessionId);
      if (sessionId === this.#defaultId) {
        this.#defaultId = manager.list()[0]?.id ?? "";
      }
      res.writeHead(204).end();
      return;
    }

    // ── A partir de acá, todo es contra una sesión concreta ─────────
    const handle = manager.get(sessionId);
    if (!handle) {
      this.#json(res, 404, { error: `sesión ${sessionId} no encontrada` });
      return;
    }

    // ── SSE: el stream de eventos de la sesión → browser ────────────
    if (method === "GET" && path === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const unsub = handle.frontend.addClient((data) => res.write(`data: ${data}\n\n`));
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        unsub();
      });
      return;
    }

    // ── Interrupt: cortar el turno en curso ─────────────────────────
    if (method === "POST" && path === "/interrupt") {
      handle.frontend.interrupt();
      res.writeHead(204).end();
      return;
    }

    // ── Input: un mensaje del browser → la cola de la sesión ────────
    if (method === "POST" && path === "/input") {
      const body = await this.#readBody(req);
      try {
        const { text } = JSON.parse(body || "{}");
        if (typeof text === "string" && text.length > 0) {
          handle.frontend.submitInput(text);
        }
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
      return;
    }

    res.writeHead(404).end();
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
}
