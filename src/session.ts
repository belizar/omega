import { Message } from "./message.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { dirname, join, basename } from "path";
import { randomUUID } from "crypto";
import { logger } from "./logger.js";
import { estimateMessagesTokens, pruneContext } from "./context-management.js";

type SessionOptions = {
  id?: string;
  // Si se setea, la sesión se persiste en <dir>/<id>.json.
  // Sin dir, la sesión vive solo en memoria (útil para tests).
  dir?: string;
  /** Máximo de tokens de contexto a exponer al modelo (default 100000). */
  maxContextTokens?: number;
};

class Session {
  #messages: Message[];
  #id: string;
  #name: string;
  #sessionPath?: string;
  #maxContextTokens: number;
  #totalCost: number;
  #totalTokens: { input: number; output: number };

  constructor(options: SessionOptions = {}) {
    this.#id = options.id ?? randomUUID();
    this.#name = "";
    this.#messages = [];
    this.#maxContextTokens = options.maxContextTokens ?? 100_000;
    this.#totalCost = 0;
    this.#totalTokens = { input: 0, output: 0 };
    this.#sessionPath = options.dir
      ? join(options.dir, `${this.#id}.json`)
      : undefined;

    // Cargar sesión anterior si existe (al reanudar por id)
    if (this.#sessionPath && existsSync(this.#sessionPath)) {
      try {
        const data = readFileSync(this.#sessionPath, "utf-8");
        const parsed = JSON.parse(data);
        this.#messages = parsed.messages || [];
        this.#totalCost = parsed.totalCost ?? 0;
        this.#totalTokens = parsed.totalTokens ?? { input: 0, output: 0 };
        this.#name = parsed.name ?? "";
        logger.info("Session loaded from file", {
          id: this.#id,
          name: this.#name || "(sin nombre)",
          messageCount: this.#messages.length,
          totalCost: this.#totalCost,
          totalTokens: this.#totalTokens,
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

  get name() {
    return this.#name;
  }

  /** Renombra la sesión y persiste el cambio */
  rename(newName: string): void {
    this.#name = newName.trim();
    this.#save();
  }

  addUserMessage(msg: string | Message["content"]) {
    this.#messages.push({
      role: "user",
      content: msg,
    } as Message);
    this.#save();
  }

  addMessage(msg: Message) {
    this.#messages.push(msg);
    this.#save();
  }

  /** Devuelve los mensajes podados por presupuesto de tokens.
   * El historial completo se guarda en disco igual. */
  get messages(): readonly Message[] {
    return pruneContext(this.#messages, this.#maxContextTokens);
  }

  /** Devuelve el historial completo sin truncar */
  get allMessages(): readonly Message[] {
    return this.#messages;
  }

  /** Tokens estimados que ocuparía el contexto actual enviado al modelo */
  get contextTokens(): number {
    return estimateMessagesTokens(this.messages);
  }

  /** Presupuesto máximo de tokens de contexto configurado */
  get maxContextTokens(): number {
    return this.#maxContextTokens;
  }

  /**
   * Acumula costo y tokens de una iteración del runner
   */
  addUsage(inputTokens: number, outputTokens: number, cost: number): void {
    this.#totalTokens = {
      input: this.#totalTokens.input + inputTokens,
      output: this.#totalTokens.output + outputTokens,
    };
    this.#totalCost += cost;
    this.#save();
  }

  get totalCost() {
    return this.#totalCost;
  }

  get totalTokens() {
    return this.#totalTokens;
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
  info(): {
    id: string;
    name: string;
    messageCount: number;
    persisted: boolean;
    path?: string;
    totalCost: number;
    totalTokens: { input: number; output: number };
  } {
    return {
      id: this.#id,
      name: this.#name,
      messageCount: this.#messages.length,
      persisted: !!this.#sessionPath,
      path: this.#sessionPath,
      totalCost: this.#totalCost,
      totalTokens: this.#totalTokens,
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
            name: this.#name || undefined,
            savedAt: new Date().toISOString(),
            messages: this.#messages,
            totalCost: this.#totalCost,
            totalTokens: this.#totalTokens,
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

  /**
   * Lista sesiones persistidas en un directorio, ordenadas por fecha de modificación (más reciente primero).
   * Devuelve info resumida: id, fecha, cantidad de mensajes, costo y tokens.
   */
  static listSessions(dir: string): Array<{
    id: string;
    name: string;
    savedAt: string;
    messageCount: number;
    totalCost: number;
    totalTokens: { input: number; output: number };
  }> {
    const results: Array<{
      id: string;
      name: string;
      savedAt: string;
      messageCount: number;
      totalCost: number;
      totalTokens: { input: number; output: number };
    }> = [];

    try {
      if (!existsSync(dir)) return results;

      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(dir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

      for (const file of files) {
        try {
          const data = readFileSync(file, "utf-8");
          const parsed = JSON.parse(data);
          results.push({
            id: parsed.id ?? basename(file, ".json"),
            name: parsed.name ?? "",
            savedAt: parsed.savedAt ?? "",
            messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
            totalCost: parsed.totalCost ?? 0,
            totalTokens: parsed.totalTokens ?? { input: 0, output: 0 },
          });
        } catch {
          // Archivo corrupto, lo salteamos
          logger.warn("Skipping corrupt session file", { file });
        }
      }
    } catch (err: unknown) {
      logger.error("Failed to list sessions", { error: err instanceof Error ? err.message : String(err) });
    }

    return results;
  }
}

export { Session };
