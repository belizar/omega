import { Message } from "./message.js";

// ── Truncado de outputs ──────────────────────────────────────────────────────

function truncate(text: string, maxLines = 200): string {
  const lines = text.split("\n");

  if (lines.length <= maxLines) return text;

  const keep = Math.floor(maxLines / 2);
  const head = lines.slice(0, keep);
  const tail = lines.slice(-keep);
  const omitted = lines.length - keep * 2;
  const marker = `\n… [${omitted} líneas omitidas. Usá un comando más específico o read con offset/limit para ver más] …\n`;

  return [...head, marker, ...tail].join("\n");
}

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
  truncate,
  estimateTokens,
  estimateMessagesTokens,
  pruneContext,
};
