import { exec } from "child_process";
import { Tool, ToolResult } from "./tool.js";
import { logger } from "../logger.js";
import { CommandClassifier } from "../classifier/classifier.js";
import type { DossierEvent } from "../dossier/types.js";
import { randomUUID } from "crypto";

type BashInput = {
  command: string;
  /** Si es true, saltea el clasificador y ejecuta el comando directamente.
   * Usar solo después de que el usuario confirmó vía ask_user. */
  force?: boolean;
  /** Notas de dossier opcionales (decisiones, gotchas, tasks, observaciones). */
  notes?: Array<{
    type: "decision" | "gotcha" | "task" | "observation";
    text: string;
    followUp?: string;
  }>;
};

export type BashToolOptions = {
  classifier?: CommandClassifier;
};

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;

const HARDBLOCK_PATTERNS = [
  /\brm\s+-[a-z]*[rf]/i,
  /:\s*\(\s*\)\s*\{.*:.*\|.*:.*\}/,
  />\s*\/dev\/(sd|nvme|disk|hd)/i,
  /\bmkfs\b/i,
  /\bdd\b.*\bof=\/dev\//i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
];

export class BashTool extends Tool<BashInput, ToolResult> {
  #classifier?: CommandClassifier;

  constructor(options?: BashToolOptions) {
    super({
      name: "bash",
      description:
        "Ejecuta un comando bash y devuelve stdout y stderr. " +
        "Acepta 'notes' opcional para emitir entries al dossier.",
      schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "El comando bash a ejecutar",
          },
          force: {
            type: "boolean",
            description:
              "Opcional. Si es true, saltea el clasificador de seguridad y ejecuta " +
              "el comando directamente. Solo debe usarse después de que el usuario " +
              "haya confirmado explícitamente vía ask_user que quiere ejecutar un " +
              "comando que fue clasificado como peligroso.",
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
        required: ["command"],
      },
    });
    this.#classifier = options?.classifier;
  }

  async execute(input: BashInput): Promise<ToolResult> {
    const { command, force, notes } = input;

    try {
      if (!command || typeof command !== "string") {
        logger.error("Invalid bash command input", { command });
        return { output: "Error: command must be a non-empty string" };
      }

      if (!force && this.isHardblocked(command)) {
        logger.warn("Hardblocked command", { command });
        return {
          output: [
            "BLOQUEADO POR GUARDARRAÍL DETERMINISTA",
            "",
            `Comando: ${command}`,
            "",
            "Razón: El comando matchea patrones de bloqueo duro",
            "(rm -rf, fork bomb, escritura a discos, etc).",
            "Estos patrones son un safety net adicional al clasificador.",
            "",
            "INSTRUCCIONES PARA EL AGENTE:",
            "- No intentes este comando con otra sintaxis o herramienta.",
            "- Informale al usuario que el guardarraíl lo bloqueó.",
            "- Si el usuario insiste, que lo ejecute manualmente.",
          ].join("\n"),
        };
      }

      if (this.#classifier && !force) {
        const classification = await this.#classifier.classify(command);

        if (classification.verdict === "dangerous") {
          const sourceTag =
            classification.source === "override"
              ? `override: "${classification.override?.pattern}"`
              : "clasificador Haiku";

          return {
            output: [
              `BLOQUEADO POR CLASIFICADOR DE SEGURIDAD (${sourceTag})`,
              "",
              `Comando: ${command}`,
              "",
              `Razón: ${classification.reason}`,
              "",
              "INSTRUCCIONES PARA EL AGENTE:",
              "- No intentes este comando con otra sintaxis o herramienta.",
              "- Informale al usuario qué comando fue bloqueado y por qué.",
              "- Si el usuario quiere ejecutarlo igual, usá ask_user para",
              "  preguntarle explícitamente, y si confirma, volvé a llamar",
              "  a bash con el mismo comando y el parámetro force: true.",
            ].join("\n"),
          };
        }
      }

      if (this.#classifier && force && this.#classifier.learnEnabled) {
        this.#classifier.learnOverride(command, "safe");
      }

      logger.info("Executing bash command", { command, force });
      const result = await new Promise<string>((resolve, reject) => {
        exec(
          command,
          {
            encoding: "buffer" as BufferEncoding,
            timeout: TIMEOUT_MS,
            maxBuffer: MAX_BUFFER,
          },
          (error, stdout, stderr) => {
            const out = Buffer.isBuffer(stdout) ? stdout.toString("utf-8") : String(stdout);
            const err = Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr);
            const combined = (out + (err ? err : "")).trim();
            if (error && !combined) {
              reject(error);
            } else {
              resolve(combined || (error?.message ?? ""));
            }
          },
        );
      });
      logger.info("Command executed successfully");

      // ── Emitir eventos de dossier (notes) ───────────────────
      const events = this.#buildEvents(notes, command);

      return {
        output: result,
        events: events.length > 0 ? events : undefined,
      };
    } catch (err: unknown) {
      const error = err as {
        code?: string;
        signal?: string;
        stderr?: string;
        stdout?: string;
        message?: string;
      };
      if (error.code === "ETIMEDOUT" || error.signal === "SIGTERM") {
        const msg = `Error: command timed out after ${TIMEOUT_MS}ms`;
        logger.warn("Bash command timed out", { command });
        return { output: msg };
      }
      const errorMsg = error.stderr || error.stdout || error.message || String(err);
      logger.error("Bash command failed", { command, error: errorMsg });
      return { output: errorMsg };
    }
  }

  #buildEvents(
    notes: BashInput["notes"],
    command: string,
  ): DossierEvent[] {
    if (!notes || !Array.isArray(notes)) return [];

    const events: DossierEvent[] = [];
    const toolUseId = randomUUID();

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

    return events;
  }

  private isHardblocked(command: string): boolean {
    return HARDBLOCK_PATTERNS.some((p) => p.test(command));
  }
}
