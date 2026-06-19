import { readFile, writeFile, mkdir, access } from "fs/promises";
import { join } from "path";
import { logger } from "../logger.js";

export type OverrideVerdict = "safe" | "dangerous";
export type OverrideSource = "manual" | "learned";

export interface Override {
  /** Patrón: texto exacto, prefijo con *, o regex entre /.../ */
  pattern: string;
  verdict: OverrideVerdict;
  reason: string;
  added: string; // ISO date
  source: OverrideSource;
  /** Cuántas veces se confirmó este override (solo learned) */
  count?: number;
}

export interface OverrideStore {
  overrides: Override[];
}

/**
 * Gestiona los overrides del clasificador.
 *
 * - Persiste en `.omega/classifier-overrides.json`.
 * - Busca matcheando patrones exactos, prefijo (*) o regex (/.../).
 * - Respeta el orden: sobre el andar, los manuales pesan más.
 */
export class OverrideManager {
  #storePath: string;
  #store: OverrideStore;

  private constructor(storePath: string, store: OverrideStore) {
    this.#storePath = storePath;
    this.#store = store;
  }

  static async load(omegaDir: string): Promise<OverrideManager> {
    const storePath = join(omegaDir, "classifier-overrides.json");
    let store: OverrideStore = { overrides: [] };

    try {
      await access(storePath);
      const raw = await readFile(storePath, "utf-8");
      const parsed = JSON.parse(raw);
      // Validación mínima
      if (parsed && Array.isArray(parsed.overrides)) {
        store = parsed as OverrideStore;
        logger.info("Loaded classifier overrides", {
          path: storePath,
          count: store.overrides.length,
        });
      }
    } catch {
      logger.info("No classifier overrides file found, starting fresh", { path: storePath });
    }

    return new OverrideManager(storePath, store);
  }

  private async persist(): Promise<void> {
    await mkdir(this.#storePath.replace(/\/[^/]+$/, ""), { recursive: true });
    await writeFile(this.#storePath, JSON.stringify(this.#store, null, 2), "utf-8");
  }

  /**
   * Busca un override que matchee el comando dado.
   * Busca primero manuales, después learned.
   */
  lookup(command: string): Override | null {
    const trimmed = command.trim();

    // Primero manuales
    for (const o of this.#store.overrides) {
      if (o.source === "manual" && this.matches(trimmed, o.pattern)) {
        return o;
      }
    }

    // Después learned
    for (const o of this.#store.overrides) {
      if (o.source === "learned" && this.matches(trimmed, o.pattern)) {
        return o;
      }
    }

    return null;
  }

  private matches(command: string, pattern: string): boolean {
    // Regex: /pattern/
    if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 1) {
      try {
        const re = new RegExp(pattern.slice(1, -1));
        return re.test(command);
      } catch {
        return false;
      }
    }

    // Wildcard: prefix*
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return command.startsWith(prefix);
    }

    // Exacto
    return command === pattern;
  }

  /**
   * Agrega un override manual. Si ya existe uno con el mismo pattern y source manual,
   * lo pisa.
   */
  async add(input: {
    pattern: string;
    verdict: OverrideVerdict;
    reason: string;
    source: OverrideSource;
  }): Promise<void> {
    const idx = this.#store.overrides.findIndex(
      (o) => o.pattern === input.pattern && o.source === "manual"
    );

    const override: Override = {
      pattern: input.pattern,
      verdict: input.verdict,
      reason: input.reason,
      added: new Date().toISOString(),
      source: input.source,
    };

    if (idx >= 0) {
      this.#store.overrides[idx] = override;
    } else {
      this.#store.overrides.push(override);
    }

    await this.persist();
  }

  /**
   * Aprende del feedback del usuario. Si es un override aprendido que ya existe,
   * incrementa el contador. Si es un patrón nuevo, lo crea.
   */
  async learn(command: string, verdict: OverrideVerdict): Promise<void> {
    // Normalizamos: guardamos el comando exacto como patrón aprendido
    const idx = this.#store.overrides.findIndex(
      (o) => o.source === "learned" && o.pattern === command.trim()
    );

    if (idx >= 0) {
      const o = this.#store.overrides[idx];
      o.verdict = verdict;
      o.count = (o.count || 0) + 1;
      o.added = new Date().toISOString();
    } else {
      this.#store.overrides.push({
        pattern: command.trim(),
        verdict,
        reason: "",
        added: new Date().toISOString(),
        source: "learned",
        count: 1,
      });
    }

    await this.persist();
  }

  /**
   * Elimina un override por pattern. Solo borra manuales.
   */
  async remove(pattern: string): Promise<boolean> {
    const idx = this.#store.overrides.findIndex(
      (o) => o.pattern === pattern && o.source === "manual"
    );
    if (idx >= 0) {
      this.#store.overrides.splice(idx, 1);
      await this.persist();
      return true;
    }
    return false;
  }

  /** Devuelve todos los overrides ordenados: manuales primero, después aprendidos. */
  list(): Override[] {
    const manual = this.#store.overrides.filter((o) => o.source === "manual");
    const learned = this.#store.overrides.filter((o) => o.source === "learned");
    return [...manual, ...learned];
  }

  /**
   * Devuelve overrides relevantes para inyectar como few-shot en el prompt
   * del clasificador. Prioriza: patrones que matchean y learned recientes.
   */
  getFewShotExamples(command: string, maxExamples = 4): Override[] {
    const trim = command.trim();
    const examples: Override[] = [];

    // Overrides cuyo pattern matchea parcialmente
    for (const o of this.#store.overrides) {
      // Prefijo común
      if (trim.startsWith(o.pattern.replace(/\*$/, "").split(" ")[0] || "")) {
        examples.push(o);
      }
      if (o.pattern.startsWith(trim.split(" ")[0] || "")) {
        if (!examples.includes(o)) examples.push(o);
      }
    }

    // Si hay pocos, agregar learned recientes
    if (examples.length < maxExamples) {
      const learned = this.#store.overrides
        .filter((o) => o.source === "learned")
        .sort((a, b) => b.added.localeCompare(a.added));

      for (const o of learned) {
        if (!examples.includes(o)) {
          examples.push(o);
          if (examples.length >= maxExamples) break;
        }
      }
    }

    return examples.slice(0, maxExamples);
  }
}
