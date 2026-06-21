import { Tool, ToolResult } from "./tool.js";
import type { DossierEvent } from "../dossier/types.js";
import { randomUUID } from "crypto";
import { logger } from "../logger.js";

type NoteInput = {
  type: "decision" | "gotcha" | "task" | "observation";
  text: string;
  followUp?: string;
};

/**
 * Tool dedicada para que el agente emita entries al dossier sin modificar
 * archivos. Puramente side-effect en el event log.
 *
 * La principal diferencia con poner `notes` en edit/write/bash es semántica:
 * esta tool explicita que el agente está pensando en "modo dossier" y le da
 * al runner una señal clara de intención.
 */
export class NoteTool extends Tool<NoteInput, ToolResult> {
  constructor() {
    super({
      name: "note",
      description:
        "Agrega una entry al dossier (working memory acotada). " +
        "Usala para registrar decisiones, gotchas, tasks u observaciones " +
        "que no vienen acopladas a la edición de un archivo. " +
        "Tipos: 'decision' (qué decidiste y por qué), 'gotcha' (algo que te sorprendió), " +
        "'task' (tarea pendiente, el runner la trackea como open hasta completarla), " +
        "'observation' (hecho observado, derivable). " +
        "Opcionalmente acepta 'followUp' que crea una task en el mismo thread.",
      schema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["decision", "gotcha", "task", "observation"],
            description: "Tipo de entry del dossier.",
          },
          text: {
            type: "string",
            description: "Texto de la entry (una línea, conciso).",
          },
          followUp: {
            type: "string",
            description:
              "Opcional. Si se provee, se crea una task adicional en el mismo thread " +
              "con este texto. Útil para el patrón 'decidí X, ahora hacele Y'.",
          },
        },
        required: ["type", "text"],
      },
    });
  }

  async execute(input: unknown): Promise<ToolResult> {
    try {
      if (typeof input !== "object" || input === null) {
        return { output: "Error: input debe ser un objeto con type y text" };
      }

      const { type, text, followUp } = input as NoteInput;

      if (!type || !text || typeof text !== "string") {
        return { output: "Error: type y text son requeridos" };
      }

      const validTypes = ["decision", "gotcha", "task", "observation"];
      if (!validTypes.includes(type)) {
        return { output: `Error: type debe ser uno de: ${validTypes.join(", ")}` };
      }

      const events: DossierEvent[] = [];
      const toolUseId = randomUUID();
      const threadId = randomUUID();

      // Entry primaria
      const noteId = randomUUID();
      events.push({
        seq: -1,
        ts: new Date().toISOString(),
        taskId: "",
        sessionId: "",
        actor: "agent",
        op: "create",
        entryId: noteId,
        snapshot: {
          id: noteId,
          type,
          text: text.trim(),
          state: type === "task" ? "open" : undefined,
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

      logger.info("NoteTool: entry added to dossier", {
        type,
        text: text.trim().slice(0, 80),
        hasFollowUp: !!(followUp && followUp.trim()),
      });

      return {
        output: `Entry [${type}] agregada al dossier: "${text.trim().slice(0, 100)}"`,
        events,
      };
    } catch (err: unknown) {
      const msg = `Error in note tool: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(msg);
      return { output: msg };
    }
  }
}
