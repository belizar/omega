import { createServer, IncomingMessage, ServerResponse } from "http";
import { Context } from "../app-context.js";
import { CoreServices } from "../core.js";
import { logger } from "../logger.js";
import { TurnRunner } from "../turn-runner.js";
import { Screen } from "../tui/screen.js";
import { WebFrontend } from "./web-frontend.js";
import { WEB_CLIENT_HTML } from "./web-client.js";
import type { FrontendMode } from "./mode.js";

/**
 * Modo `serve`: hostea el core detrás de un server HTTP y lo maneja desde un
 * browser. El tercer consumidor del stream de eventos del Runner (después de TUI
 * y headless) — la prueba más dura de que el core no se filtró a la terminal.
 *
 * Transporte cero-dep sobre el `http` nativo:
 *   GET  /         → el cliente (una SPA vanilla)
 *   GET  /events   → SSE: el stream de eventos del agente al browser
 *   POST /input    → un mensaje del browser a la cola del agente
 *
 * El `WebFrontend` es un hub por sesión: N browsers pueden mirar (broadcast) y
 * mandar (cola mergeada). Atado a 127.0.0.1: un agente que corre bash NO puede
 * quedar expuesto. Auth + multi-tenancy son la capa de nube, no el MVP.
 */
export class ServeMode implements FrontendMode {
  #core: CoreServices;
  #port: number;

  constructor(core: CoreServices, port: number) {
    this.#core = core;
    this.#port = port;
  }

  async run(): Promise<void> {
    const { config, session, agentConfig, toolRegistry, classifier } = this.#core;

    const frontend = new WebFrontend({ model: config.model, sessionId: session.id });

    // Screen inerte: satisface la dependencia del Context sin enganchar la
    // terminal (igual que headless). El web nunca renderiza por acá.
    const screen = new Screen(config.screenPadding);
    const ctx = new Context({ session, agentConfig, screen, toolRegistry, classifier });
    const turnRunner = new TurnRunner(this.#core, ctx, frontend);

    const server = createServer((req, res) => this.#handle(req, res, frontend));
    // 127.0.0.1 a propósito: NO 0.0.0.0. El agente corre bash/edit; exponerlo a
    // la red sin auth sería un agujero. La versión de red va con auth (nube).
    await new Promise<void>((resolve) => {
      server.listen(this.#port, "127.0.0.1", () => resolve());
    });
    const url = `http://localhost:${this.#port}`;
    process.stderr.write(`\n  Ω omega serve  →  ${url}\n  (Ctrl+C para cortar)\n\n`);
    logger.info("web server up", { url, session: session.id });

    frontend.start();

    // El loop del agente: mismo patrón que la TUI, pero el input viene de la red.
    // Se bloquea en nextInput hasta que un cliente postea un mensaje.
    for (;;) {
      const inp = await frontend.nextInput();
      if (inp.kind === "exit") break;
      if (inp.kind === "none") continue;
      session.addUserMessage(inp.text);
      await turnRunner.run();
    }

    frontend.stop();
    server.close();
  }

  #handle(req: IncomingMessage, res: ServerResponse, frontend: WebFrontend): void {
    const method = req.method ?? "GET";
    const url = (req.url ?? "/").split("?")[0];

    // ── El cliente ──────────────────────────────────────────────────
    if (method === "GET" && (url === "/" || url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(WEB_CLIENT_HTML);
      return;
    }

    // ── SSE: el stream de eventos del agente → browser ─────────────
    if (method === "GET" && url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const unsub = frontend.addClient((data) => res.write(`data: ${data}\n\n`));
      // Ping para que proxies no maten la conexión ociosa.
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        unsub();
      });
      return;
    }

    // ── Interrupt: cortar el turno en curso (Esc / botón stop) ─────
    if (method === "POST" && url === "/interrupt") {
      frontend.interrupt();
      res.writeHead(204).end();
      return;
    }

    // ── Input: un mensaje del browser → la cola del agente ─────────
    if (method === "POST" && url === "/input") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { text } = JSON.parse(body || "{}");
          if (typeof text === "string" && text.length > 0) {
            frontend.submitInput(text);
          }
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }

    res.writeHead(404).end();
  }
}
