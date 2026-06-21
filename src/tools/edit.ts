import { readFile, writeFile } from "fs/promises";
import { Tool, ToolResult } from "./tool.js";
import { logger } from "../logger.js";
import { isEnvFile, ENV_BLOCK_MESSAGE } from "./env-guard.js";
import type { DossierEvent } from "../dossier/types.js";
import { randomUUID } from "crypto";

export type EditInput = {
  path: string;
  oldText: string;
  newText: string;
  /** Explicación de qué cambiás y por qué. Requerido: la tool rechaza si falta. */
  rationale?: string;
  /** Notas de dossier opcionales (decisiones, gotchas, tasks, observaciones). */
  notes?: Array<{
    type: "decision" | "gotcha" | "task" | "observation";
    text: string;
    followUp?: string;
  }>;
};

export class EditTool extends Tool<EditInput, ToolResult> {
  constructor() {
    super({
      name: "edit",
      description:
        "Reemplaza quirúrgicamente texto exacto dentro de un archivo. " +
        "Requiere 'rationale' explicando qué cambiás y por qué. " +
        "Acepta 'notes' opcional para emitir entries al dossier.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ruta del archivo a editar" },
          oldText: {
            type: "string",
            description:
              "Texto exacto a reemplazar (debe matchear carácter por carácter, incluido el whitespace)",
          },
          newText: {
            type: "string",
            description: "Texto nuevo que reemplaza al viejo",
          },
          rationale: {
            type: "string",
            description: "Explicación de qué cambiás y por qué (una línea). Requerido.",
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
        required: ["path", "oldText", "newText", "rationale"],
      },
    });
  }

  async execute(input: unknown): Promise<ToolResult> {
    try {
      if (typeof input !== "object" || input === null) {
        throw new Error("Input must be an object with path, oldText, and newText");
      }

      const { path, oldText, newText, rationale, notes } = input as EditInput;

      if (typeof path !== "string" || typeof oldText !== "string" || typeof newText !== "string") {
        throw new Error("path, oldText, and newText must be strings");
      }

      // rationale requerido: rechazar si falta o está vacío
      if (!rationale || typeof rationale !== "string" || !rationale.trim()) {
        logger.warn("Edit rejected: rationale vacío", { path });
        return {
          output: "Error: rationale es requerido. Explicá qué cambiás y por qué (una línea).",
        };
      }

      if (isEnvFile(path)) {
        logger.warn("Blocked edit of env file", { path });
        return { output: ENV_BLOCK_MESSAGE };
      }

      logger.info("Editing file", { path, oldTextLength: oldText.length, newTextLength: newText.length });

      let content: string;
      try {
        content = await readFile(path, "utf-8");
      } catch (err: unknown) {
        throw new Error(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }

      const occurrences = content.split(oldText).length - 1;

      if (occurrences === 0) {
        logger.warn("Text not found in file", { path });
        throw new Error(`Text to replace not found in ${path}. Ensure it matches exactly.`);
      }

      if (occurrences > 1) {
        logger.warn("Multiple occurrences found", { path, occurrences });
        throw new Error(
          `Text appears ${occurrences} times in ${path}, ambiguous. Include more context.`,
        );
      }

      const updated = content.replace(oldText, newText);
      try {
        await writeFile(path, updated, "utf-8");
      } catch (err: unknown) {
        throw new Error(`Could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }

      logger.info("File edited successfully", { path });

      // ── Emitir evento file ──────────────────────────────────────
      const events: DossierEvent[] = [];
      const toolUseId = randomUUID(); // placeholder, el runner lo va a sobrescribir

      events.push({
        seq: -1, // el journal asigna el real
        ts: new Date().toISOString(),
        taskId: "", // el runner lo completa
        sessionId: "", // el runner lo completa
        actor: "agent",
        op: "create",
        entryId: randomUUID(),
        snapshot: {
          id: "", // se rellena arriba
          type: "file",
          text: rationale,
          refs: { path, toolUseId },
        },
      });
      // Corregir el entryId dentro del snapshot
      events[0].snapshot!.id = events[0].entryId!;

      // ── Procesar notes (sidecar) ────────────────────────────────
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
        output: `Editado ${path} correctamente.`,
        events: events.length > 0 ? events : undefined,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : `Unknown error editing file`;
      logger.error(errorMsg, { error: err });
      return { output: `Error: ${errorMsg}` };
    }
  }
}
