import { randomUUID } from "crypto";
import { DossierJournal, buildLiveDossier } from "./journal.js";
import { foldDossier, FoldOptions } from "./fold.js";
import { evictDossier, EvictionOptions, EvictionResult } from "./eviction.js";
import { DossierEvent, Entry, Note, Op } from "./types.js";
import { logger } from "../logger.js";

/**
 * Configuración del Dossier.
 */
export type DossierOptions = {
  /** Directorio donde guardar los JSONL (default: ".omega/dossiers"). */
  dir?: string;
  /** Budget de tokens para el fold (default: 3000). */
  foldMaxTokens?: number;
  /** Factor chars/token (default: 4). */
  charsPerToken?: number;
  /** Umbral mínimo de tokens en tier alto para disparar evicción (default: 1000). */
  highTierMinTokens?: number;
};

/**
 * El Dossier es la working memory acotada de una tarea.
 *
 * Orquesta:
 * - Journal: append-only JSONL (fuente de verdad).
 * - Live: dossier vivo reconstruido del journal, expuesto vía fold().
 * - Eviction: política de evicción por budget.
 * - Fold: serialización para el prompt del LLM.
 */
export class Dossier {
  #journal: DossierJournal;
  #options: Required<DossierOptions>;
  #taskId: string;
  #sessionId: string;

  constructor(taskId: string, options: DossierOptions = {}) {
    this.#taskId = taskId;
    this.#sessionId = randomUUID();
    this.#options = {
      dir: options.dir ?? ".omega/dossiers",
      foldMaxTokens: options.foldMaxTokens ?? 3000,
      charsPerToken: options.charsPerToken ?? 4,
      highTierMinTokens: options.highTierMinTokens ?? 1000,
    };
    this.#journal = new DossierJournal(this.#options.dir, taskId);
  }

  // ── Propiedades ─────────────────────────────────────────────────────

  get taskId(): string {
    return this.#taskId;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  /** El dossier vivo: último snapshot por entryId, excluyendo evictadas. */
  get live(): Map<string, Entry> {
    return buildLiveDossier(this.#journal.readAll());
  }

  /** Todos los eventos del journal (para análisis / métricas). */
  get events(): DossierEvent[] {
    return this.#journal.readAll();
  }

  // ── Mutación ─────────────────────────────────────────────────────────

  /**
   * Ingiere un evento externo (de una tool) en el journal.
   * Rellena taskId y sessionId con los valores actuales del dossier.
   */
  ingestEvent(event: DossierEvent): DossierEvent {
    return this.#append({
      ts: event.ts,
      taskId: this.#taskId,
      sessionId: this.#sessionId,
      actor: event.actor,
      op: event.op,
      entryId: event.entryId,
      snapshot: event.snapshot,
    });
  }

  /** Arranca una nueva sesión dentro del mismo task. Resetea sessionId. */
  startSession(): void {
    this.#sessionId = randomUUID();
    this.taskStart();
  }

  /** Finaliza la sesión actual (lifecycle event). */
  endSession(): void {
    this.sessionEnd();
  }

  /**
   * Procesa un conjunto de Notes (del sidecar de una tool) y genera
   * eventos de creación. Maneja el patrón de dos notas (followUp).
   *
   * @param notes - Las notas emitidas por el agente en el sidecar.
   * @param toolUseId - El ID de la tool call que generó estas notas
   *                    (para trazabilidad vía refs.toolUseId).
   * @returns Los eventos generados (ya appendeaos al journal).
   */
  processNotes(notes: Note[], toolUseId: string): DossierEvent[] {
    const ts = new Date().toISOString();
    const events: DossierEvent[] = [];

    for (const note of notes) {
      const threadId = randomUUID();

      // Entry primaria
      const primaryId = randomUUID();
      const primary: Entry = {
        id: primaryId,
        type: note.type,
        text: note.text,
        state: note.type === "task" ? "open" : undefined,
        threadId,
        refs: { toolUseId },
      };

      const primaryEvent = this.#append({
        ts,
        taskId: this.#taskId,
        sessionId: this.#sessionId,
        actor: "agent",
        op: "create",
        entryId: primaryId,
        snapshot: primary,
      });
      events.push(primaryEvent);

      // Si hay followUp, crear task secundaria en el mismo thread
      if (note.followUp && note.followUp.trim()) {
        const taskId = randomUUID();
        const task: Entry = {
          id: taskId,
          type: "task",
          text: note.followUp,
          state: "open",
          threadId,
          refs: { toolUseId },
        };

        const taskEvent = this.#append({
          ts,
          taskId: this.#taskId,
          sessionId: this.#sessionId,
          actor: "agent",
          op: "create",
          entryId: taskId,
          snapshot: task,
        });
        events.push(taskEvent);
      }
    }

    logger.info("Dossier: processed notes", {
      noteCount: notes.length,
      eventsGenerated: events.length,
      taskId: this.#taskId,
    });

    return events;
  }

  /**
   * Crea una entry de tipo `file` a partir del rationale de edit/write.
   * Es forzado: si no hay rationale, la tool debería haber rechazado.
   *
   * @param rationale - El rationale provisto por la tool ("qué cambiás y por qué").
   * @param toolUseId - ID de la tool call.
   * @param path - Archivo modificado.
   * @param line - Línea aproximada (opcional).
   */
  recordFileTouch(
    rationale: string,
    toolUseId: string,
    path: string,
    line?: number,
  ): DossierEvent {
    const id = randomUUID();
    const entry: Entry = {
      id,
      type: "file",
      text: rationale,
      refs: { path, line, toolUseId },
    };

    const event = this.#append({
      ts: new Date().toISOString(),
      taskId: this.#taskId,
      sessionId: this.#sessionId,
      actor: "agent",
      op: "create",
      entryId: id,
      snapshot: entry,
    });

    return event;
  }

  /**
   * Actualiza el estado de una task (open → done / dropped).
   */
  completeTask(
    entryId: string,
    state: "done" | "dropped",
  ): DossierEvent {
    const current = this.live.get(entryId);
    const updated: Entry = {
      ...(current ?? { id: entryId, type: "task", text: "" }),
      state,
    };

    return this.#append({
      ts: new Date().toISOString(),
      taskId: this.#taskId,
      sessionId: this.#sessionId,
      actor: "agent",
      op: state === "done" ? "complete" : "drop",
      entryId,
      snapshot: updated,
    });
  }

  /**
   * Marca una entry como superseded por otra (ej: nueva decision que
   * reemplaza una anterior).
   */
  supersede(oldEntryId: string, newEntryId: string): DossierEvent {
    return this.#append({
      ts: new Date().toISOString(),
      taskId: this.#taskId,
      sessionId: this.#sessionId,
      actor: "agent",
      op: "supersede",
      entryId: oldEntryId,
    });
  }

  /**
   * Promueve una entry a long-term memory (marca para AGENT.md).
   */
  promote(entryId: string): DossierEvent {
    return this.#append({
      ts: new Date().toISOString(),
      taskId: this.#taskId,
      sessionId: this.#sessionId,
      actor: "agent",
      op: "promote",
      entryId,
    });
  }

  /**
   * Registra el inicio de una tarea (lifecycle event).
   */
  taskStart(): DossierEvent {
    return this.#append({
      ts: new Date().toISOString(),
      taskId: this.#taskId,
      sessionId: this.#sessionId,
      actor: "system",
      op: "task_start",
    });
  }

  /**
   * Registra el fin de sesión (lifecycle event).
   */
  sessionEnd(): DossierEvent {
    return this.#append({
      ts: new Date().toISOString(),
      taskId: this.#taskId,
      sessionId: this.#sessionId,
      actor: "system",
      op: "session_end",
    });
  }

  // ── Fold ──────────────────────────────────────────────────────────────

  /**
   * Construye el fold del dossier vivo para inyectar en el prompt.
   * Aplica el budget de tokens configurado.
   */
  fold(options?: FoldOptions): { text: string; includedIds: Set<string> } {
    return foldDossier(this.live, {
      maxTokens: options?.maxTokens ?? this.#options.foldMaxTokens,
      charsPerToken: options?.charsPerToken ?? this.#options.charsPerToken,
    });
  }

  // ── Evicción ─────────────────────────────────────────────────────────

  /**
   * Ejecuta la escalera de evicción si el tier alto excede el umbral.
   * Appendea los eventos de evicción al journal.
   */
  evict(options?: EvictionOptions): EvictionResult {
    const baseEvent = {
      ts: new Date().toISOString(),
      taskId: this.#taskId,
      sessionId: this.#sessionId,
      actor: "system" as const,
    };

    const result = evictDossier(this.live, baseEvent, {
      maxTokens: options?.maxTokens ?? this.#options.foldMaxTokens,
      charsPerToken: options?.charsPerToken ?? this.#options.charsPerToken,
      highTierMinTokens: options?.highTierMinTokens ?? this.#options.highTierMinTokens,
    });

    // Appendear los eventos generados al journal
    for (const event of result.events) {
      this.#append(event);
    }

    logger.info("Dossier: eviction run", {
      evicted: result.evicted,
      compressed: result.compressed,
      liveCount: result.live.size,
      taskId: this.#taskId,
    });

    return result;
  }

  // ── Privados ─────────────────────────────────────────────────────────

  #append(event: Omit<DossierEvent, "seq">): DossierEvent {
    return this.#journal.append(event);
  }
}
