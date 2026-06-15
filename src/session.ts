import { Message } from "./message.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { logger } from "./logger.js";

type SessionOptions = {
  id?: string;
  // Si se setea, la sesión se persiste en <dir>/<id>.json.
  // Sin dir, la sesión vive solo en memoria (útil para tests).
  dir?: string;
};

class Session {
  #messages: Message[];
  #id: string;
  #sessionPath?: string;

  constructor(options: SessionOptions = {}) {
    this.#id = options.id ?? randomUUID();
    this.#messages = [];
    this.#sessionPath = options.dir
      ? join(options.dir, `${this.#id}.json`)
      : undefined;

    // Cargar sesión anterior si existe (al reanudar por id)
    if (this.#sessionPath && existsSync(this.#sessionPath)) {
      try {
        const data = readFileSync(this.#sessionPath, "utf-8");
        const parsed = JSON.parse(data);
        this.#messages = parsed.messages || [];
        logger.info("Session loaded from file", {
          id: this.#id,
          messageCount: this.#messages.length,
        });
      } catch (err: unknown) {
        logger.warn("Failed to load session file, starting fresh", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  get id() {
    return this.#id;
  }

  addUserMessage(msg: string) {
    this.#messages.push({
      role: "user",
      content: msg,
    });
    this.#save();
  }

  addMessage(msg: Message) {
    this.#messages.push(msg);
    this.#save();
  }

  get messages() {
    return this.#messages;
  }

  /**
   * Limpia el historial de mensajes
   */
  clear(): void {
    this.#messages = [];
    this.#save();
  }

  /**
   * Devuelve información de la sesión
   */
  info(): { id: string; messageCount: number; persisted: boolean; path?: string } {
    return {
      id: this.#id,
      messageCount: this.#messages.length,
      persisted: !!this.#sessionPath,
      path: this.#sessionPath,
    };
  }

  #save(): void {
    if (!this.#sessionPath) return;

    try {
      const dir = dirname(this.#sessionPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        this.#sessionPath,
        JSON.stringify(
          {
            id: this.#id,
            savedAt: new Date().toISOString(),
            messages: this.#messages,
          },
          null,
          2,
        ),
        "utf-8",
      );
    } catch (err: unknown) {
      logger.error("Failed to save session", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export { Session };
