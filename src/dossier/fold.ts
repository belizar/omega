import { Entry, TYPE_PRIORITY } from "./types.js";

/**
 * Parámetros de configuración del fold.
 */
export type FoldOptions = {
  /** Budget máximo de tokens para el fold (default: 3000). */
  maxTokens?: number;
  /** Factor de chars por token para la estimación (default: 4). */
  charsPerToken?: number;
};

const DEFAULT_MAX_TOKENS = 3000;
const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Serializa una entry en una línea para el fold del prompt.
 * Formato: `[tipo] texto (refs: path:line)`
 * - El texto se aplana a una línea (newlines → espacios).
 * - Si tiene rationale, se embebe en el texto: "texto — rationale".
 */
function serializeEntry(entry: Entry): string {
  let text = entry.text.replace(/\n/g, " ").trim();

  // Embeber rationale si existe
  if (entry.rationale && entry.rationale.trim()) {
    const rat = entry.rationale.replace(/\n/g, " ").trim();
    text = `${text} — ${rat}`;
  }

  // Armar refs
  const refParts: string[] = [];
  if (entry.refs?.path) {
    let ref = entry.refs.path;
    if (entry.refs.line !== undefined) ref += `:${entry.refs.line}`;
    refParts.push(ref);
  }

  const refsStr = refParts.length > 0 ? ` (refs: ${refParts.join(", ")})` : "";

  return `[${entry.type}] ${text}${refsStr}`;
}

/**
 * Estima los tokens que ocuparía una línea serializada.
 */
function estimateTokens(line: string, charsPerToken: number): number {
  return Math.ceil(line.length / charsPerToken);
}

/**
 * Construye el fold del dossier: la proyección del dossier vivo a texto
 * acotado por budget, listo para inyectar en el prompt del LLM.
 *
 * Estrategia:
 * 1. Agrupar entries por tipo.
 * 2. Ordenar grupos por prioridad (decision > gotcha > task > file > observation).
 * 3. Dentro de cada grupo, ordenar por estado (open tasks primero) y después
 *    las más recientes primero (por id lexicográfico inverso como proxy).
 * 4. Serializar línea por línea, cortando cuando se excede el budget.
 *
 * Devuelve el texto del fold y el set de IDs que entraron.
 */
export function foldDossier(
  liveEntries: Map<string, Entry>,
  options: FoldOptions = {},
): { text: string; includedIds: Set<string> } {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;

  const maxChars = maxTokens * charsPerToken;

  // ── 1. Agrupar por tipo ──────────────────────────────────────────────
  const byType: Record<Entry["type"], Entry[]> = {
    decision: [],
    gotcha: [],
    task: [],
    file: [],
    observation: [],
  };

  for (const entry of liveEntries.values()) {
    byType[entry.type].push(entry);
  }

  // ── 2. Ordenar dentro de cada grupo ──────────────────────────────────
  // Tasks: open primero, luego done/dropped.
  // El resto: sin orden de estado especial.
  const stateRank = (s?: string): number => {
    if (s === "open") return 0;
    if (s === "done" || s === "dropped") return 1;
    return 2; // sin estado
  };

  const sortFn = (a: Entry, b: Entry): number => {
    // Primero por estado (open tasks primero)
    const rankDiff = stateRank(a.state) - stateRank(b.state);
    if (rankDiff !== 0) return rankDiff;
    // Después por id (lexicográfico inverso como proxy de recencia)
    return b.id.localeCompare(a.id);
  };

  for (const type of Object.keys(byType) as Entry["type"][]) {
    byType[type].sort(sortFn);
  }

  // ── 3. Iterar en orden de prioridad, llenando el budget ─────────────
  const order: Entry["type"][] = ["decision", "gotcha", "task", "file", "observation"];

  let charsUsed = 0;
  const lines: string[] = [];
  const includedIds = new Set<string>();

  for (const type of order) {
    for (const entry of byType[type]) {
      const line = serializeEntry(entry);
      const tokens = estimateTokens(line, charsPerToken);
      const chars = line.length + 1; // +1 por el newline

      if (charsUsed + chars > maxChars) {
        // Budget lleno: cortamos. Lo que no entra simplemente no se incluye
        // en este step pero sigue vivo (truncado no destructivo).
        return { text: lines.join("\n"), includedIds };
      }

      lines.push(line);
      charsUsed += chars;
      includedIds.add(entry.id);
    }
  }

  return { text: lines.join("\n"), includedIds };
}
