import { appendFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { DossierEvent, Entry } from "./types.js";
import { logger } from "../logger.js";

/**
 * Append-only JSONL log. Es la fuente de verdad del dossier.
 * Cada línea es un DossierEvent serializado.
 */
export class DossierJournal {
  #filePath: string;
  #seq: number;

  constructor(dir: string, taskId: string) {
    mkdirSync(dir, { recursive: true });
    this.#filePath = `${dir}/${taskId}.jsonl`;
    this.#seq = this.#loadSeq();
  }

  /** Agrega un evento al log. Devuelve el evento con seq asignado. */
  append(event: Omit<DossierEvent, "seq">): DossierEvent {
    const full: DossierEvent = { ...event, seq: this.#seq++ };
    const line = JSON.stringify(full) + "\n";
    try {
      appendFileSync(this.#filePath, line, "utf-8");
    } catch (err: unknown) {
      logger.error("Failed to append to dossier journal", {
        file: this.#filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    return full;
  }

  /** Lee todos los eventos del log (para rebuildear el dossier vivo). */
  readAll(): DossierEvent[] {
    if (!existsSync(this.#filePath)) return [];
    try {
      const raw = readFileSync(this.#filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line) as DossierEvent);
    } catch (err: unknown) {
      logger.error("Failed to read dossier journal", {
        file: this.#filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  get filePath(): string {
    return this.#filePath;
  }

  /** Cuenta cuántas líneas (eventos) hay en el log. */
  #loadSeq(): number {
    if (!existsSync(this.#filePath)) return 0;
    try {
      const raw = readFileSync(this.#filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      return lines.length;
    } catch {
      return 0;
    }
  }
}

/**
 * Reconstruye el "dossier vivo" a partir de un array de eventos.
 * Devuelve un Map<entryId, Entry> con el último snapshot de cada entry.
 * Las entries evictadas (op: "evict") no aparecen.
 */
export function buildLiveDossier(events: DossierEvent[]): Map<string, Entry> {
  const live = new Map<string, Entry>();

  for (const event of events) {
    if (!event.entryId) continue;

    if (event.op === "evict") {
      live.delete(event.entryId);
      continue;
    }

    if (event.snapshot) {
      live.set(event.entryId, { ...event.snapshot });
    }
  }

  return live;
}
