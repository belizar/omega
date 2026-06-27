import { Message } from "./message.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { dirname, join, basename } from "path";
import { randomUUID } from "crypto";
import { logger } from "./logger.js";
import {
  compactStaleReads,
  estimateMessagesTokens,
  pruneContext,
} from "./context-management.js";

type SessionOptions = {
  id?: string;
  // Si se setea, la sesión se persiste en <dir>/<id>.json.
  // Sin dir, la sesión vive solo en memoria (útil para tests).
  dir?: string;
  /** Máximo de tokens de contexto a exponer al modelo (default 100000). */
  maxContextTokens?: number;
  /** Modelo usado (para auditoría de costos). */
  model?: string;
};

class Session {
  #messages: Message[];
  /** Contexto de trabajo con compactaciones aplicadas (se mantiene sincronizado
   * con #messages, pero con reads viejos compactados). Se persiste en disco
   * para que al reanudar no haya que reprocesar. */
  #workingContext: Message[];
  #id: string;
  #name: string;
  #sessionPath?: string;
  #maxContextTokens: number;
  #model: string;
  #totalCost: number;
  #totalTokens: { input: number; output: number };
  #stepUsage: Array<{
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cost: number;
  }>;
  /** Flag: un comando modal inyectó un user message y hay que disparar el runner. */
  #pendingRunner: boolean;

  constructor(options: SessionOptions = {}) {
    this.#id = options.id ?? randomUUID();
    this.#name = "";
    this.#messages = [];
    this.#workingContext = [];
    this.#maxContextTokens = options.maxContextTokens ?? 100_000;
    this.#model = options.model ?? "";
    this.#totalCost = 0;
    this.#totalTokens = { input: 0, output: 0 };
    this.#stepUsage = [];
    this.#pendingRunner = false;
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
        this.#stepUsage = parsed.stepUsage ?? [];
        this.#name = parsed.name ?? "";
        this.#model = parsed.model ?? "";

        // workingContext: si existe en disco, se carga; si no (formato viejo), se regenera
        if (parsed.workingContext && Array.isArray(parsed.workingContext)) {
          this.#workingContext = parsed.workingContext;
        } else {
          this.#workingContext = compactStaleReads(this.#messages);
        }

        logger.info("Session loaded from file", {
          id: this.#id,
          name: this.#name || "(sin nombre)",
          messageCount: this.#messages.length,
          workingContextSize: this.#workingContext.length,
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

  /** Modelo usado en esta sesión (para auditoría). */
  get model() {
    return this.#model;
  }

  /** Setea el modelo (llamado por index.ts al iniciar). */
  setModel(model: string): void {
    this.#model = model;
    this.#save();
  }

  /** Comando modal inyectó un user message → el REPL debe disparar el runner. */
  get pendingRunner(): boolean {
    return this.#pendingRunner;
  }

  /** Consume el flag (llamado por el REPL después de disparar el runner). */
  consumePendingRunner(): void {
    this.#pendingRunner = false;
  }

  /** Agrega un user message y marca para que el runner lo procese. */
  injectUserMessage(content: Message["content"]): void {
    const msg: Message = { role: "user", content };
    this.#messages.push(msg);
    this.#workingContext.push(msg);
    this.#pendingRunner = true;
    this.#save();
  }

  /** Renombra la sesión y persiste el cambio */
  rename(newName: string): void {
    this.#name = newName.trim();
    this.#save();
  }

  addUserMessage(msg: string | Message["content"]) {
    const message = {
      role: "user",
      content: msg,
    } as Message;
    this.#messages.push(message);
    this.#workingContext.push(message);
    this.#save();
  }

  addMessage(msg: Message) {
    this.#messages.push(msg);
    this.#workingContext.push(msg);
    this.#save();
  }

  /** Devuelve el historial completo de mensajes (sin compactar, sin podar).
   * Para auditoría y debugging. */
  get messages(): readonly Message[] {
    return this.#messages;
  }

  /** Devuelve el contexto de trabajo con compactaciones aplicadas.
   * Para debugging y tests. */
  get workingContext(): readonly Message[] {
    return this.#workingContext;
  }

  /** Contexto listo para enviar al modelo: workingContext podado por tokens. */
  getContext(): readonly Message[] {
    return pruneContext(this.#workingContext, this.#maxContextTokens);
  }

  /** Aplica compactación de reads viejos al workingContext.
   * Se llama al final de cada turno del runner. */
  compactWorkingContext(options?: {
    staleSteps?: number;
    minLines?: number;
  }): void {
    this.#workingContext = compactStaleReads(this.#workingContext, options);
    this.#save();
  }

  /** Tokens estimados que ocuparía el contexto actual enviado al modelo */
  get contextTokens(): number {
    return estimateMessagesTokens(this.getContext());
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

  /** Acumula el stepUsage que el Runner midió por step. */
  addStepUsage(
    steps: Array<{
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      cost: number;
    }>,
  ): void {
    this.#stepUsage.push(...steps);
    this.#save();
  }

  get stepUsage(): readonly {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cost: number;
  }[] {
    return this.#stepUsage;
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
    this.#workingContext = [];
    this.#stepUsage = [];
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
    model?: string;
  } {
    return {
      id: this.#id,
      name: this.#name,
      messageCount: this.#messages.length,
      persisted: !!this.#sessionPath,
      path: this.#sessionPath,
      totalCost: this.#totalCost,
      totalTokens: this.#totalTokens,
      model: this.#model || undefined,
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
            workingContext: this.#workingContext,
            totalCost: this.#totalCost,
            totalTokens: this.#totalTokens,
            stepUsage: this.#stepUsage,
            model: this.#model || undefined,
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
    model?: string;
  }> {
    const results: Array<{
      id: string;
      name: string;
      savedAt: string;
      messageCount: number;
      totalCost: number;
      totalTokens: { input: number; output: number };
      model?: string;
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
            model: parsed.model ?? undefined,
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
