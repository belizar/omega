import { Message } from "./message.js";

// ── Compactación de reads viejos ─────────────────────────────────────────────

interface ReadRegistryEntry {
  toolUseId: string;
  path: string;
  turnNumber: number;
  lineCount: number;
}

interface CompactOptions {
  /** Reads con más de N turnos de antigüedad se compactan. Default: 3. */
  staleTurns?: number;
  /** Solo se compactan reads con más de N líneas. Default: 20. */
  minLines?: number;
}

/**
 * Compacta tool_results de reads viejos dentro del contexto de trabajo.
 * Dos mecanismos:
 *  A. Por antigüedad: si un read tiene >staleTurns turnos, se reemplaza
 *     por un marcador.
 *  B. Por edición: si un archivo fue editado después de ser leído, el read
 *     se invalida.
 *
 * No muta los mensajes de entrada; devuelve un nuevo array con shallow
 * clones de los mensajes modificados.
 */
/** Si el content de un tool_result ya es un marcador de compactación,
 * extrae el lineCount original. Devuelve 0 si no es un marcador reconocido. */
function parseCompactedLineCount(content: string): number {
  const m = content.match(/^\[leído .+ hace \d+ turnos — (\d+) líneas omitidas\]$/);
  return m ? parseInt(m[1], 10) : 0;
}

function compactStaleReads(
  messages: readonly Message[],
  options: CompactOptions = {},
): Message[] {
  const { staleTurns = 3, minLines = 20 } = options;

  // ── Fase 1: scan ──────────────────────────────────────────────────────────
  let turnNumber = 0;
  const readRegistry = new Map<string, ReadRegistryEntry>();
  const lastEditTurn = new Map<string, number>();

  for (const msg of messages) {
    // Incrementar turno en cada user de texto (no tool_result)
    if (msg.role === "user") {
      if (Array.isArray(msg.content)) {
        const isToolResult = msg.content.some(
          (b) =>
            b && typeof b === "object" && "type" in b && b.type === "tool_result",
        );
        if (!isToolResult) turnNumber++;
      } else {
        turnNumber++;
      }
    }

    // Registrar reads
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          block.type === "tool_use" &&
          "name" in block &&
          block.name === "read" &&
          "id" in block &&
          "input" in block
        ) {
          const input = block.input as { path?: string };
          readRegistry.set(block.id as string, {
            toolUseId: block.id as string,
            path: input.path ?? "desconocido",
            turnNumber,
            lineCount: 0,
          });
        }
        // Registrar edits/writes
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          block.type === "tool_use" &&
          "name" in block &&
          (block.name === "edit" || block.name === "write") &&
          "input" in block
        ) {
          const input = block.input as { path?: string };
          if (input.path) {
            lastEditTurn.set(input.path, turnNumber);
          }
        }
      }
    }

    // Actualizar lineCount de reads cuando vemos el tool_result.
    // Si el contenido ya es un marcador de compactación, parseamos el lineCount
    // original para que la edad se recalcule en cada pasada en vez de congelarse.
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          block.type === "tool_result" &&
          "tool_use_id" in block &&
          "content" in block
        ) {
          const entry = readRegistry.get(block.tool_use_id as string);
          if (entry && typeof block.content === "string") {
            const compacted = parseCompactedLineCount(block.content);
            entry.lineCount = compacted > 0 ? compacted : block.content.split("\n").length;
          }
        }
      }
    }
  }

  // ── Fase 2: compact ─────────────────────────────────────────────────────────
  const currentTurn = turnNumber;
  const result: Message[] = [];

  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }

    // Verificar si este mensaje contiene tool_results de reads a compactar
    let hasCompacted = false;
    const newContent = msg.content.map((block) => {
      if (
        !block ||
        typeof block !== "object" ||
        !("type" in block) ||
        block.type !== "tool_result" ||
        !("tool_use_id" in block)
      ) {
        return block;
      }

      const entry = readRegistry.get(block.tool_use_id as string);
      if (!entry) return block;

      const origIsError = "is_error" in block ? (block as { is_error: boolean }).is_error : false;

      // B: invalidación por edición posterior (sin gate de minLines — si se
      //    editó, el contenido viejo es inválido sin importar el tamaño).
      const editTurn = lastEditTurn.get(entry.path);
      if (editTurn !== undefined && editTurn > entry.turnNumber) {
        hasCompacted = true;
        return {
          type: "tool_result" as const,
          tool_use_id: block.tool_use_id as string,
          content: `[${entry.path} fue editado después — el contenido anterior ya no es válido]`,
          is_error: origIsError,
        };
      }

      // A: compactación por antigüedad (solo si supera minLines)
      if (entry.lineCount >= minLines) {
        const age = currentTurn - entry.turnNumber;
        if (age > staleTurns) {
          hasCompacted = true;
          return {
            type: "tool_result" as const,
            tool_use_id: block.tool_use_id as string,
            content: `[leído ${entry.path} hace ${age} turnos — ${entry.lineCount} líneas omitidas]`,
            is_error: origIsError,
          };
        }
      }

      return block;
    });

    if (hasCompacted) {
      result.push({ ...msg, content: newContent });
    } else {
      result.push(msg);
    }
  }

  return result;
}

// ── Truncado de outputs ──────────────────────────────────────────────────────

/** Trunca para mostrar al usuario: límite visual, no inunda la terminal. */
function truncateForDisplay(
  text: string,
  maxLines = 50,
  maxChars = 2000,
): string {
  let t = text;
  if (t.length > maxChars) {
    const half = Math.floor(maxChars / 2);
    t =
      t.slice(0, half) +
      `\n… [${t.length - maxChars} chars omitidos] …\n` +
      t.slice(-half);
  }
  const lines = t.split("\n");
  if (lines.length <= maxLines) return t;

  const keep = Math.max(1, Math.floor(maxLines / 2));
  const head = lines.slice(0, keep);
  const tail = lines.slice(-keep);
  const omitted = lines.length - keep * 2;
  const marker = `\n… [${omitted} líneas omitidas. Usá un comando más específico o read con offset/limit para ver más] …\n`;
  return [...head, marker, ...tail].join("\n");
}

/**
 * Safety net: trunca output para el LLM si supera un porcentaje del
 * presupuesto de contexto. Así un solo tool_result no satura la ventana.
 * Si el texto está dentro del límite, lo devuelve intacto.
 */
function truncateForContext(
  text: string,
  maxContextTokens: number,
  maxPercent = 0.25,
): string {
  const maxTokens = Math.floor(maxContextTokens * maxPercent);
  const textTokens = estimateTokens(text);
  if (textTokens <= maxTokens) return text;

  // Cortamos a ~maxChars equivalente
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const half = Math.floor(maxChars / 2);
  return (
    text.slice(0, half) +
    `\n… [${text.length - maxChars} chars omitidos por presupuesto] …\n` +
    text.slice(-half)
  );
}

// Mantenemos truncate como alias legacy (usan runner.ts y tests)
const truncate = truncateForDisplay;

// ── Estimación de tokens ─────────────────────────────────────────────────────

/**
 * Estimación con ~3 chars/token. Para texto natural el ratio real es ~4
 * chars/token, así que tendemos a SOBREstimar tokens, que es la dirección
 * segura: podamos de más, no de menos. Además maxContextTokens (100k)
 * está por debajo de la ventana real (~200k) como colchón extra.
 */
const CHARS_PER_TOKEN = 3;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estima los tokens que ocuparía un array de mensajes al serializarse.
 * No es exacto (el formato real depende del provider: Anthropic vs OpenAI)
 * pero sirve para decidir cuántos mensajes entran en el presupuesto.
 */
function estimateMessagesTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(JSON.stringify(msg));
  }
  return total;
}

// ── Helpers turn-aware ───────────────────────────────────────────────────────

/** ¿Este mensaje user es en realidad un bloque de tool_results? */
function isToolResultMessage(msg: Message): boolean {
  return (
    msg.role === "user" &&
    Array.isArray(msg.content) &&
    msg.content.length > 0 &&
    msg.content.some(
      (b) => b && typeof b === "object" && "type" in b && b.type === "tool_result",
    )
  );
}

/** ¿Es un punto de inicio válido para la ventana de contexto?
 *  (user de texto real, no un tool_result, no un assistant) */
function isValidWindowStart(msg: Message): boolean {
  return msg.role === "user" && !isToolResultMessage(msg);
}

// ── Poda de contexto por tokens ──────────────────────────────────────────────

/**
 * Recorta el historial desde el más antiguo hasta que el total estimado
 * de tokens entre dentro del presupuesto. Es turn-aware: nunca corta en
 * medio de un par tool_use / tool_result, ni deja un assistant como primer
 * mensaje de la ventana (lo que rompería el formato del provider).
 */
function pruneContext(
  messages: readonly Message[],
  maxTokens: number,
): Message[] {
  if (messages.length === 0) return [];

  // 1. Punto de corte tentativo por presupuesto (de más reciente a más antiguo)
  let startIdx = 0;
  let tokensUsed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(JSON.stringify(messages[i]));
    if (tokensUsed + msgTokens > maxTokens && i < messages.length - 1) {
      startIdx = i + 1;
      break;
    }
    tokensUsed += msgTokens;
  }

  // 2. Avanzar startIdx hasta un inicio de turno válido (user de texto real).
  //    Descarta tool_results huérfanos y assistants al principio de la ventana.
  while (startIdx < messages.length && !isValidWindowStart(messages[startIdx])) {
    startIdx++;
  }

  // 3. Si nos pasamos de todo (turno actual gigante), devolver desde el
  //    último user válido para al menos no romper el formato.
  if (startIdx >= messages.length) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isValidWindowStart(messages[i])) return messages.slice(i);
    }
    return [...messages]; // fallback: mandar todo y que el provider se queje
  }

  return messages.slice(startIdx);
}

export {
  compactStaleReads,
  truncate,
  truncateForDisplay,
  truncateForContext,
  estimateTokens,
  estimateMessagesTokens,
  pruneContext,
};
