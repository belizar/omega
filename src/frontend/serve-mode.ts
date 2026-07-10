import { execFile } from "child_process";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { promisify } from "util";
import { CoreServices } from "../core.js";
import { logger } from "../logger.js";

const execFileAsync = promisify(execFile);
import { CreateSessionOpts, SessionManager, SessionMode } from "./session-manager.js";
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
  #baseDir = "";

  constructor(core: CoreServices, port: number) {
    this.#core = core;
    this.#port = port;
  }

  async run(): Promise<void> {
    const baseDir = process.cwd();
    this.#baseDir = baseDir;
    const manager = new SessionManager(this.#core, { baseDir });
    this.#manager = manager;

    // Arranque sin amnesia: si el índice ya tiene sesiones de este proyecto,
    // revivo la más reciente como default (te devuelve donde estabas). Si no hay
    // ninguna, creo la "principal" (comparte cwd — la UX single-sesión de siempre).
    const dormant = manager.listAll();
    if (dormant.length > 0) {
      const revived = await manager.revive(dormant[0].id);
      this.#defaultId = revived ? revived.id : (await manager.create({ title: "principal" })).id;
      logger.info("sesiones dormidas encontradas", { total: dormant.length, revived: this.#defaultId });
    } else {
      this.#defaultId = (await manager.create({ title: "principal" })).id;
    }

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

    // ── Sesiones: listar (vivas + dormidas) ─────────────────────────
    if (method === "GET" && path === "/sessions") {
      this.#json(res, 200, { sessions: manager.listAll(), default: this.#defaultId });
      return;
    }

    // ── Sesiones: crear ─────────────────────────────────────────────
    if (method === "POST" && path === "/sessions") {
      const body = await this.#readBody(req);
      let opts: CreateSessionOpts = {};
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
        res.writeHead(400).end();
        return;
      }
      let handle;
      try {
        handle = await manager.create(opts);
      } catch (err) {
        // Ej: la branch ya tiene un worktree, o el path ya existe.
        this.#json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      this.#json(res, 201, {
        id: handle.id,
        title: handle.title,
        cwd: handle.workspace.cwd,
        isolated: handle.workspace.isolated,
        branch: handle.workspace.branch,
      });
      return;
    }

    // ── Sesiones: dormir (detach) ───────────────────────────────────
    // No destruye nada: para el loop y la deja dormida (sigue en la lista,
    // revivible). Cerrar ≠ borrar — nada se elimina por sorpresa.
    if (method === "DELETE" && path === "/sessions") {
      await manager.detach(sessionId);
      res.writeHead(204).end();
      return;
    }

    // ── Worktrees del repo: sugerencias para el modo attach ─────────
    if (method === "GET" && path === "/worktrees") {
      this.#json(res, 200, { worktrees: await this.#listWorktrees() });
      return;
    }

    // ── Rescan: re-importar transcripts huérfanos al índice ─────────
    if (method === "POST" && path === "/rescan") {
      const imported = await manager.rescan();
      this.#json(res, 200, { imported });
      return;
    }

    // ── Revelar el cwd de la sesión en el explorador (Finder/etc) ───
    // Usa cwdOf (no revive): funciona para vivas y dormidas. Solo abre el cwd
    // conocido de una sesión — nunca un path arbitrario del cliente.
    if (method === "POST" && path === "/reveal") {
      const cwd = manager.cwdOf(sessionId);
      if (!cwd) {
        this.#json(res, 404, { error: `sesión ${sessionId} desconocida` });
        return;
      }
      this.#reveal(cwd);
      res.writeHead(204).end();
      return;
    }

    // ── A partir de acá, todo es contra una sesión concreta ─────────
    // Si está dormida (en el índice pero sin loop), la revivimos on-demand:
    // cargar el transcript y re-attachear su workspace.
    const handle = manager.get(sessionId) ?? (await manager.revive(sessionId)) ?? undefined;
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
  #reveal(cwd: string): void {
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
