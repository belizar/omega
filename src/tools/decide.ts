import { Tool, ToolResult } from "./tool.js";
import type { DossierEvent } from "../dossier/types.js";
import { randomUUID } from "crypto";
import { logger } from "../logger.js";

type DecideInput = {
  text: string;
  /** Opcional: entryId de una decisión anterior que esta reemplaza. */
  supersedes?: string;
  /** Opcional: texto de una task de seguimiento. */
  followUp?: string;
};

/**
 * Tool para registrar decisiones en el dossier.
 *
 * A diferencia de `note`, esta tool:
 * - Fuerza el type a "decision".
 * - Soporta `supersedes` para marcar decisiones anteriores como obsoletas.
 * - Es semánticamente explícita: "estoy decidiendo algo".
 */
export class DecideTool extends Tool<DecideInput, ToolResult> {
  constructor() {
    super({
      name: "decide",
      description:
        "Registra una decisión en el dossier. " +
        "Usala cuando tomás una decisión de arquitectura, diseño o approach. " +
        "Opcionalmente acepta 'supersedes' (entryId de una decisión previa que esta reemplaza) " +
        "y 'followUp' (texto de una task de seguimiento en el mismo thread).",
      schema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "La decisión tomada (una línea, concisa). Ej: 'Usar SQLite en vez de JSON'.",
          },
          supersedes: {
            type: "string",
            description:
              "Opcional. ID de una entry de decisión anterior que esta nueva decisión reemplaza.",
          },
          followUp: {
            type: "string",
            description:
              "Opcional. Texto de una task de seguimiento que se crea en el mismo thread.",
          },
        },
        required: ["text"],
      },
    });
  }

  async execute(input: unknown): Promise<ToolResult> {
    try {
      if (typeof input !== "object" || input === null) {
        return { output: "Error: input debe ser un objeto con text" };
      }

      const { text, supersedes, followUp } = input as DecideInput;

      if (!text || typeof text !== "string" || !text.trim()) {
        return { output: "Error: text es requerido y no puede estar vacío" };
      }

      const events: DossierEvent[] = [];
      const toolUseId = randomUUID();
      const threadId = randomUUID();

      // Marcar decisión anterior como superseded
      if (supersedes && typeof supersedes === "string" && supersedes.trim()) {
        events.push({
          seq: -1,
          ts: new Date().toISOString(),
          taskId: "",
          sessionId: "",
          actor: "agent",
          op: "supersede",
          entryId: supersedes.trim(),
        });
      }

      // Entry de decisión
      const decisionId = randomUUID();
      events.push({
        seq: -1,
        ts: new Date().toISOString(),
        taskId: "",
        sessionId: "",
        actor: "agent",
        op: "create",
        entryId: decisionId,
        snapshot: {
          id: decisionId,
          type: "decision",
          text: text.trim(),
          threadId,
          refs: { toolUseId },
        },
      });

      // Follow-up task
      if (followUp && followUp.trim()) {
        const followUpId = randomUUID();
        events.push({
          seq: -1,
          ts: new Date().toISOString(),
          taskId: "",
          sessionId: "",
          actor: "agent",
          op: "create",
          entryId: followUpId,
          snapshot: {
            id: followUpId,
            type: "task",
            text: followUp.trim(),
            state: "open",
            threadId,
            refs: { toolUseId },
          },
        });
      }

      const supersededMsg = supersedes ? ` (reemplaza ${supersedes})` : "";
      logger.info("DecideTool: decision recorded", {
        text: text.trim().slice(0, 80),
        supersedes,
        hasFollowUp: !!(followUp && followUp.trim()),
      });

      return {
        output: `Decisión registrada${supersededMsg}: "${text.trim().slice(0, 100)}"`,
        events,
      };
    } catch (err: unknown) {
      const msg = `Error in decide tool: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(msg);
      return { output: msg };
    }
  }
}