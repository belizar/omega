import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { logger } from "../logger.js";

/**
 * Una referencia liviana a una sesión, viva o dormida. El índice guarda esto
 * (no el transcript) para poder pintar el sidebar sin abrir cada .json y, sobre
 * todo, para saber DÓNDE revivir una sesión: su workspace (cwd/branch) no vive
 * en el transcript, vive acá.
 */
export interface IndexEntry {
  id: string;
  title: string;
  /** baseDir del server que la creó (para el scope por-proyecto; global = Inc C). */
  project: string;
  /** Path absoluto al .json del transcript (para cargarlo al revivir). */
  sessionFile: string;
  /** Directorio de trabajo de la sesión (el worktree, o el baseDir si compartida). */
  cwd: string;
  /** Branch del worktree (undefined si comparte cwd). */
  branch?: string;
  isolated: boolean;
  /** ¿Omega creó el worktree (true) o solo se enganchó a uno tuyo (false, attach)?
   *  Un worktree prestado nunca se borra. */
  owned: boolean;
  /** Archivada: sigue en el índice (revivible), pero el sidebar la esconde por
   *  default para no bloatear la UI. NO es borrar — es "sacar de la vista". */
  archived?: boolean;
  /** Orden manual en el sidebar (drag-and-drop). Si no está, se ordena por
   *  createdAt (orden de creación estable). Reordenar reasigna 0..N. */
  order?: number;
  createdAt: number;
  lastActive: number;
}

/** Ruta por defecto del índice global. */
export const DEFAULT_INDEX_PATH = join(homedir(), ".omega", "index.json");

/**
 * Índice global de sesiones en `~/.omega/index.json`. Es un CACHE de referencias
 * (la verdad es el filesystem: los transcripts y los worktrees). Sobrevive al
 * reinicio del server → es lo que hace que las sesiones no tengan amnesia.
 */
export class SessionIndex {
  #path: string;
  #entries = new Map<string, IndexEntry>();

  constructor(path: string = DEFAULT_INDEX_PATH) {
    this.#path = path;
    this.#load();
  }

  #load(): void {
    try {
      if (!existsSync(this.#path)) return;
      const data = JSON.parse(readFileSync(this.#path, "utf-8"));
      for (const e of data.sessions ?? []) {
        if (e && typeof e.id === "string") this.#entries.set(e.id, e);
      }
    } catch (err) {
      logger.warn("no se pudo leer el índice de sesiones", {
        path: this.#path,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const sessions = [...this.#entries.values()];
      writeFileSync(this.#path, JSON.stringify({ sessions }, null, 2), "utf-8");
    } catch (err) {
      logger.warn("no se pudo escribir el índice de sesiones", {
        path: this.#path,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  upsert(entry: IndexEntry): void {
    this.#entries.set(entry.id, entry);
    this.#save();
  }

  /** Actualiza lastActive (y opcionalmente el título) de una entrada existente. */
  touch(id: string, lastActive: number, title?: string): void {
    const e = this.#entries.get(id);
    if (!e) return;
    e.lastActive = lastActive;
    if (title) e.title = title;
    this.#save();
  }

  /** Renombra una entrada (persiste). El nombre legible que ve el sidebar. */
  rename(id: string, title: string): void {
    const e = this.#entries.get(id);
    if (!e) return;
    e.title = title;
    this.#save();
  }

  /** Archiva/desarchiva (persiste). Archivada = escondida del sidebar, no borrada. */
  setArchived(id: string, archived: boolean): void {
    const e = this.#entries.get(id);
    if (!e) return;
    e.archived = archived;
    this.#save();
  }

  /** Reordena: asigna `order` = posición según el arreglo de ids dado (los que no
   *  aparezcan quedan como estén). Persiste una sola vez. */
  reorder(ids: string[]): void {
    let changed = false;
    ids.forEach((id, i) => {
      const e = this.#entries.get(id);
      if (e && e.order !== i) {
        e.order = i;
        changed = true;
      }
    });
    if (changed) this.#save();
  }

  remove(id: string): void {
    if (this.#entries.delete(id)) this.#save();
  }

  get(id: string): IndexEntry | undefined {
    return this.#entries.get(id);
  }

  /** Entradas de un proyecto (baseDir), más recientes primero. */
  forProject(project: string): IndexEntry[] {
    return [...this.#entries.values()]
      .filter((e) => e.project === project)
      .sort((a, b) => b.lastActive - a.lastActive);
  }

  /** Todas las entradas, más recientes primero (para el daemon global). */
  all(): IndexEntry[] {
    return [...this.#entries.values()].sort((a, b) => b.lastActive - a.lastActive);
  }
}
