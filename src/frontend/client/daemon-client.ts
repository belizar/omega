import { spawn } from "child_process";
import { get, request } from "http";
import { SessionInfo } from "../daemon/session-manager.js";

/** Un evento del daemon (contrato web estable): {type, ...}. */
export type DaemonEvent = { type: string; [k: string]: unknown };

/**
 * Cliente HTTP/SSE del daemon (`omega --serve`). Es lo que convierte a la TUI en
 * una ventana más del mismo runtime: no corre el loop del agente, le habla al
 * daemon por el mismo protocolo que el browser. `ensureUp()` levanta el daemon en
 * background si no está corriendo (como el CLI de docker con dockerd).
 */
export class DaemonClient {
  #host = "127.0.0.1";
  #port: number;

  constructor(port: number) {
    this.#port = port;
  }

  get port(): number {
    return this.#port;
  }

  // ── REST ──────────────────────────────────────────────────────────

  #req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: this.#host,
          port: this.#port,
          method,
          path,
          headers: payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {},
          timeout: 10_000,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            let json: any = null;
            try {
              json = data ? JSON.parse(data) : null;
            } catch {
              /* respuesta sin JSON (204, etc.) */
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      if (payload) req.write(payload);
      req.end();
    });
  }

  async ping(): Promise<boolean> {
    try {
      const { status } = await this.#req("GET", "/sessions");
      return status === 200;
    } catch {
      return false;
    }
  }

  async sessions(): Promise<{ sessions: SessionInfo[]; default: string }> {
    const { json } = await this.#req("GET", "/sessions");
    return { sessions: json?.sessions ?? [], default: json?.default ?? "" };
  }

  async create(opts: {
    mode?: string;
    cwd?: string;
    branch?: string;
    base?: string;
    title?: string;
  }): Promise<{ id: string; error?: string }> {
    const { json } = await this.#req("POST", "/sessions", opts);
    return json ?? {};
  }

  async detach(id: string): Promise<void> {
    await this.#req("DELETE", `/sessions?session=${encodeURIComponent(id)}`);
  }

  async rename(id: string, title: string): Promise<string | null> {
    const { json } = await this.#req("PATCH", `/sessions?session=${encodeURIComponent(id)}`, { title });
    return json?.title ?? null;
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    await this.#req("POST", `/archive?session=${encodeURIComponent(id)}`, { archived });
  }

  async input(id: string, text: string): Promise<void> {
    await this.#req("POST", `/input?session=${encodeURIComponent(id)}`, { text });
  }

  async interrupt(id: string): Promise<void> {
    await this.#req("POST", `/interrupt?session=${encodeURIComponent(id)}`);
  }

  async reveal(id: string): Promise<void> {
    await this.#req("POST", `/reveal?session=${encodeURIComponent(id)}`);
  }

  async worktrees(): Promise<Array<{ path: string; branch?: string }>> {
    const { json } = await this.#req("GET", "/worktrees");
    return json?.worktrees ?? [];
  }

  async rescan(): Promise<number> {
    const { json } = await this.#req("POST", "/rescan");
    return json?.imported ?? 0;
  }

  // ── SSE ───────────────────────────────────────────────────────────

  /** Se suscribe al stream de eventos de una sesión. Devuelve la baja. */
  events(id: string, onEvent: (ev: DaemonEvent) => void): () => void {
    const req = get(
      { host: this.#host, port: this.#port, path: `/events?session=${encodeURIComponent(id)}` },
      (res) => {
        let buf = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          // Los eventos SSE se separan por línea en blanco.
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            for (const line of block.split("\n")) {
              if (!line.startsWith("data: ")) continue; // ": ping"/comentarios afuera
              try {
                onEvent(JSON.parse(line.slice(6)));
              } catch {
                /* línea de data corrupta: la ignoramos */
              }
            }
          }
        });
      },
    );
    req.on("error", () => {
      /* el daemon cayó o se cortó la conexión: la baja la maneja el caller */
    });
    return () => req.destroy();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /** Asegura que el daemon esté corriendo: si no responde, lo levanta en
   *  background (detached) y espera a que quede listo. */
  async ensureUp(timeoutMs = 10_000): Promise<boolean> {
    if (await this.ping()) return true;

    // Mismo binario, corriendo como server. Hereda el cwd (baseDir del daemon).
    const child = spawn(process.execPath, [process.argv[1], "--serve", "--port", String(this.#port)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      if (await this.ping()) return true;
    }
    return false;
  }
}
