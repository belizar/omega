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
 * Estimación conservadora: ~3 caracteres por token.
 * Funciona razonablemente bien para código y español.
 * Con 3 chars/token tendemos a subestimar ligeramente la cantidad de tokens
 * que el contenido va a ocupar, lo cual es seguro (nos pasamos de
 * presupuesto antes que quedarnos cortos).
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

// ── Poda de contexto por tokens ──────────────────────────────────────────────

/**
 * Recorta el historial desde el más antiguo hasta que el total estimado
 * de tokens entre dentro del presupuesto. Siempre conserva al menos
 * el último mensaje (el input del usuario).
 */
function pruneContext(
  messages: readonly Message[],
  maxTokens: number,
): Message[] {
  if (messages.length === 0) return [];

  const result: Message[] = [];
  let tokensUsed = 0;

  // Recorremos del más reciente al más antiguo
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(JSON.stringify(messages[i]));
    // Si no es el primer mensaje que agregamos y no entra, cortamos
    if (tokensUsed + msgTokens > maxTokens && result.length > 0) {
      break;
    }
    result.unshift(messages[i]);
    tokensUsed += msgTokens;
  }

  return result;
}

export {
  truncate,
  estimateTokens,
  estimateMessagesTokens,
  pruneContext,
};
