import { Entry, DossierEvent } from "./types.js";

/**
 * Configuración de la evicción.
 */
export type EvictionOptions = {
  /** Budget de tokens del fold (default: 3000). */
  maxTokens?: number;
  /** Factor chars/token para estimación (default: 4). */
  charsPerToken?: number;
  /** Mínimo de tokens que deben ocupar los tiers altos (decisions + gotchas +
   *  open tasks) para que NO se dispare la evicción destructiva. */
  highTierMinTokens?: number;
};

const DEFAULT_MAX_TOKENS = 3000;
const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_HIGH_TIER_MIN_TOKENS = 1000;

/** Tipos que se consideran "tier alto" (lo que no queremos evictar). */
const HIGH_TIER: Set<Entry["type"]> = new Set(["decision", "gotcha", "task"]);

/**
 * Estima tokens de una entry (chars / charsPerToken).
 */
function entryTokens(entry: Entry, charsPerToken: number): number {
  const len = entry.text.length + (entry.rationale?.length ?? 0);
  return Math.ceil(len / charsPerToken);
}

/**
 * Resultado de una pasada de evicción.
 */
export type EvictionResult = {
  /** Events de evicción y compresión generados (para appendear al journal). */
  events: Omit<DossierEvent, "seq">[];
  /** Las entries que quedan vivas después de la evicción. */
  live: Map<string, Entry>;
  /** Cuántas entries fueron evictadas. */
  evicted: number;
  /** Cuántas entries fueron comprimidas. */
  compressed: number;
};

/**
 * Ejecuta la escalera de evicción sobre el dossier vivo.
 *
 * Se dispara solo cuando los tiers altos (decisions + gotchas + open tasks)
 * suman más tokens que el budget disponible, y el tier alto mismo supera
 * el umbral mínimo (highTierMinTokens).
 *
 * Escalera:
 *   1. done/dropped tasks (se evictan primero)
 *   2. observations (se evictan)
 *   3. files (se comprimen: dropea el outline, mantiene el rationale;
 *      si ya están comprimidas, se evictan)
 *   4. open tasks (se evictan)
 *   5. gotchas / decisions (último recurso, se evictan)
 *
 * Dentro de cada nivel, se ordena por antigüedad (id lexicográfico creciente
 * = más antiguo primero) como proxy de LRU.
 */
export function evictDossier(
  liveEntries: Map<string, Entry>,
  baseEvent: Pick<DossierEvent, "ts" | "taskId" | "sessionId" | "actor">,
  options: EvictionOptions = {},
): EvictionResult {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const highTierMinTokens = options.highTierMinTokens ?? DEFAULT_HIGH_TIER_MIN_TOKENS;

  const events: Omit<DossierEvent, "seq">[] = [];
  const live = new Map(liveEntries);
  let evicted = 0;
  let compressed = 0;

  // ── Calcular tokens totales de lo que está vivo ───────────────────
  let totalTokens = 0;
  for (const entry of live.values()) {
    totalTokens += entryTokens(entry, charsPerToken);
  }

  // Si todo entra en el budget, no hay nada que hacer
  if (totalTokens <= maxTokens) {
    return { events, live, evicted: 0, compressed: 0 };
  }

  // ── Calcular tokens del tier alto ──────────────────────────────────
  let highTierTokens = 0;
  for (const entry of live.values()) {
    if (HIGH_TIER.has(entry.type)) {
      // Para tasks, solo cuentan las open
      if (entry.type === "task" && entry.state !== "open") continue;
      highTierTokens += entryTokens(entry, charsPerToken);
    }
  }

  // Si el tier alto no llega al umbral, no evictamos — simplemente
  // el fold truncará lo que no entra (no destructivo).
  if (highTierTokens <= highTierMinTokens) {
    return { events, live, evicted: 0, compressed: 0 };
  }

  // ── Si el tier alto mismo no entra en el budget, hay que evictar
  //    también del tier alto. Señal de que el budget es muy chico.
  const needHighTierEviction = highTierTokens > maxTokens;

  // ── Armar buckets ordenados por la escalera ────────────────────────

  // 1. Done/dropped tasks primero
  const doneTasks = [...live.values()]
    .filter((e) => e.type === "task" && (e.state === "done" || e.state === "dropped"))
    .sort((a, b) => a.id.localeCompare(b.id));

  // 2. Observations
  const observations = [...live.values()]
    .filter((e) => e.type === "observation")
    .sort((a, b) => a.id.localeCompare(b.id));

  // 3. Files (primero comprimir, luego evictar)
  const files = [...live.values()]
    .filter((e) => e.type === "file")
    .sort((a, b) => a.id.localeCompare(b.id));

  // 4. Open tasks (solo si needHighTierEviction)
  const openTasks = [...live.values()]
    .filter((e) => e.type === "task" && e.state === "open")
    .sort((a, b) => a.id.localeCompare(b.id));

  // 5. Decisions + gotchas (solo si needHighTierEviction)
  const decisionsGotchas = [...live.values()]
    .filter((e) => e.type === "decision" || e.type === "gotcha")
    .sort((a, b) => a.id.localeCompare(b.id));

  /**
   * Helper: evicta entries de una lista hasta liberar `needed` tokens.
   * Devuelve cuántas se evictaron.
   */
  const evictFrom = (
    entries: Entry[],
    needed: number,
    liveMap: Map<string, Entry>,
  ): number => {
    let freed = 0;
    let count = 0;
    for (const entry of entries) {
      if (freed >= needed) break;
      if (!liveMap.has(entry.id)) continue; // ya fue procesada
      freed += entryTokens(entry, charsPerToken);
      count++;
      liveMap.delete(entry.id);
      events.push({
        ...baseEvent,
        op: "evict",
        entryId: entry.id,
        mechanism: "ladder",
        snapshot: entry,
      });
    }
    return count;
  };

  // ── Paso 1: evictar done/dropped tasks ─────────────────────────────
  totalTokens = [...live.values()].reduce((s, e) => s + entryTokens(e, charsPerToken), 0);
  if (totalTokens > maxTokens) {
    const needed = totalTokens - maxTokens;
    const freed = evictFrom(doneTasks, needed, live);
    evicted += freed;
    totalTokens = [...live.values()].reduce((s, e) => s + entryTokens(e, charsPerToken), 0);
  }

  // ── Paso 2: evictar observations ───────────────────────────────────
  if (totalTokens > maxTokens) {
    const needed = totalTokens - maxTokens;
    const freed = evictFrom(observations, needed, live);
    evicted += freed;
    totalTokens = [...live.values()].reduce((s, e) => s + entryTokens(e, charsPerToken), 0);
  }

  // ── Paso 3: comprimir files ────────────────────────────────────────
  if (totalTokens > maxTokens) {
    const needed = totalTokens - maxTokens;
    let freed = 0;
    for (const entry of files) {
      if (freed >= needed) break;
      if (!live.has(entry.id)) continue;

      // Si ya está comprimida (sin refs.path o ya muy chica), evictar directamente
      if (!entry.refs?.path) {
        freed += entryTokens(entry, charsPerToken);
        evicted++;
        live.delete(entry.id);
        events.push({
          ...baseEvent,
          op: "evict",
          entryId: entry.id,
          mechanism: "ladder",
          snapshot: entry,
        });
        continue;
      }

      // Comprimir: dropear path y line, mantener rationale + texto
      const tokensBefore = entryTokens(entry, charsPerToken);
      const compressedEntry: Entry = {
        ...entry,
        text: entry.text,
        refs: { ...entry.refs, path: undefined, line: undefined },
      };
      const tokensAfter = entryTokens(compressedEntry, charsPerToken);

      live.set(entry.id, compressedEntry);
      compressed++;
      freed += tokensBefore - tokensAfter;

      events.push({
        ...baseEvent,
        op: "compress",
        entryId: entry.id,
        mechanism: "ladder",
        snapshot: compressedEntry,
      });
    }
    totalTokens = [...live.values()].reduce((s, e) => s + entryTokens(e, charsPerToken), 0);
  }

  // ── Pasos 4-5: tier alto (solo si es necesario) ────────────────────
  if (needHighTierEviction && totalTokens > maxTokens) {
    const needed = totalTokens - maxTokens;
    const freed = evictFrom(openTasks, needed, live);
    evicted += freed;
    totalTokens = [...live.values()].reduce((s, e) => s + entryTokens(e, charsPerToken), 0);
  }

  if (needHighTierEviction && totalTokens > maxTokens) {
    const needed = totalTokens - maxTokens;
    const freed = evictFrom(decisionsGotchas, needed, live);
    evicted += freed;
  }

  return { events, live, evicted, compressed };
}
