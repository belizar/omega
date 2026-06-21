import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { Tool, ToolResult } from "./tool.js";
import { logger } from "../logger.js";
import { isEnvFile, ENV_BLOCK_MESSAGE } from "./env-guard.js";
import type { DossierEvent } from "../dossier/types.js";
import { randomUUID } from "crypto";

type WriteInput = {
  path: string;
  content: string;
  /** Explicación de qué creás/escribís y por qué. Requerido: la tool rechaza si falta. */
  rationale?: string;
  /** Notas de dossier opcionales. */
  notes?: Array<{
    type: "decision" | "gotcha" | "task" | "observation";
    text: string;
    followUp?: string;
  }>;
};

export class WriteTool extends Tool<WriteInput, ToolResult> {
  constructor() {
    super({
      name: "write",
      description:
        "Crea un archivo nuevo o sobrescribe uno existente con el contenido dado. " +
        "Requiere 'rationale' explicando qué creás/escribís y por qué. " +
        "Acepta 'notes' opcional para emitir entries al dossier.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ruta del archivo a escribir" },
          content: {
            type: "string",
            description: "Contenido completo a escribir en el archivo",
          },
          rationale: {
            type: "string",
            description: "Explicación de qué creás/escribís y por qué (una línea). Requerido.",
          },
          notes: {
            type: "array",
            description:
              "Notas de dossier opcionales. Cada nota tiene type (decision/gotcha/task/observation), text, y followUp opcional.",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["decision", "gotcha", "task", "observation"],
                },
                text: { type: "string" },
                followUp: { type: "string" },
              },
              required: ["type", "text"],
            },
          },
        },
        required: ["path", "content", "rationale"],
      },
    });
  }

  async execute(input: unknown): Promise<ToolResult> {
    try {
      if (typeof input !== "object" || input === null) {
        throw new Error("Input must be an object with path and content");
      }

      const { path, content, rationale, notes } = input as WriteInput;

      if (typeof path !== "string" || typeof content !== "string") {
        throw new Error("path and content must be strings");
      }

      if (!path.trim()) {
        throw new Error("path cannot be empty");
      }

      // rationale requerido
      if (!rationale || typeof rationale !== "string" || !rationale.trim()) {
        logger.warn("Write rejected: rationale vacío", { path });
        return {
          output: "Error: rationale es requerido. Explicá qué creás/escribís y por qué (una línea).",
        };
      }

      if (isEnvFile(path)) {
        logger.warn("Blocked write to env file", { path });
        return { output: ENV_BLOCK_MESSAGE };
      }

      logger.info("Writing file", { path, size: content.length });
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf-8");
      logger.info("File written successfully", { path });

      // ── Emitir evento file ──────────────────────────────────────
      const events: DossierEvent[] = [];
      const toolUseId = randomUUID();

      events.push({
        seq: -1,
        ts: new Date().toISOString(),
        taskId: "",
        sessionId: "",
        actor: "agent",
        op: "create",
        entryId: randomUUID(),
        snapshot: {
          id: "",
          type: "file",
          text: rationale,
          refs: { path, toolUseId },
        },
      });
      events[0].snapshot!.id = events[0].entryId!;

      // ── Procesar notes ──────────────────────────────────────────
      if (notes && Array.isArray(notes)) {
        for (const note of notes) {
          if (!note.type || !note.text) continue;
          const threadId = randomUUID();
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
              type: note.type,
              text: note.text,
              state: note.type === "task" ? "open" : undefined,
              threadId,
              refs: { toolUseId },
            },
          });

          if (note.followUp && note.followUp.trim()) {
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
                text: note.followUp,
                state: "open",
                threadId,
                refs: { toolUseId },
              },
            });
          }
        }
      }

      return {
        output: `Escrito ${path} correctamente.`,
        events: events.length > 0 ? events : undefined,
      };
    } catch (err: unknown) {
      const errorMsg = `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(errorMsg, { error: err });
      return { output: errorMsg };
    }
  }
}
