/** Ops disponibles en el event log del dossier.
 *
 * Nota: "migrate" y "milestone_advance" son del Proyecto 2
 * (multisession-orchestration), no de este módulo. */
export type Op =
  | "create"            // nacimiento
  | "update"            // mutación de campos
  | "complete"          // task completada
  | "drop"              // task dropeada
  | "supersede"         // entry reemplazada por otra (ej: nueva decision)
  | "compress"          // file comprimida por presión de budget (actor:system)
  | "evict"             // entry removida del set vivo (actor:system)
  | "promote"           // graduación a long-term memory
  | "task_start"        // lifecycle: se arranca una tarea (entryId nulo)
  | "session_end";      // lifecycle: fin de sesión (entryId nulo)

/** Un evento en el log append-only del dossier. */
export type DossierEvent = {
  seq: number;              // orden monotónico (≈ nro de línea del JSONL)
  ts: string;               // ISO timestamp
  taskId: string;
  sessionId: string;        // SIEMPRE — la unidad mecánica (un Runner.run)
  milestone?: number;       // OPCIONAL — vacío en single-session
  actor: "agent" | "system";
  op: Op;
  entryId?: string;         // nulo en lifecycle ops (task_start, session_end)
  mechanism?: "ladder" | "manual";  // por qué un evict/compress (para métricas)
  delta?: Partial<Entry>;   // qué cambió (legibilidad de la mutación)
  snapshot?: Entry;         // estado completo tras aplicar
};

/** Una entry del dossier. Es la unidad de working memory acotada. */
export type Entry = {
  id: string;
  type: "decision" | "gotcha" | "task" | "file" | "observation";
  text: string;
  state?: "open" | "done" | "dropped";   // solo relevante para tasks
  threadId?: string;
  refs?: { path?: string; line?: number; toolUseId?: string };
  rationale?: string;        // el "por qué" acoplado a la acción
  tokens?: number;           // peso estimado (chars/4)
};

/** Lo que el agente pone en el sidecar `notes?: Note[]` de edit/write/bash.
 * `file` NO va por acá — va por el `rationale` requerido de la mutación. */
export type Note = {
  type: "decision" | "gotcha" | "task" | "observation";
  text: string;
  followUp?: string;   // texto de una task a crear, enlazada por threadId
};

// ── Prioridad de tipos para fold y evicción ─────────────────────────────────

/** Orden de prioridad: menor número = más importante = se muestra primero y
 * se evicta último. */
export const TYPE_PRIORITY: Record<Entry["type"], number> = {
  decision: 1,
  gotcha: 2,
  task: 3,      // open tasks son prioridad 3; done/dropped son 3 también pero
                // la evicción las saca primero por estado
  file: 4,
  observation: 5,
};
