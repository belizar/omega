import { exec } from "child_process";
import { Tool } from "./tool.js";
import { logger } from "../logger.js";
import { CommandClassifier } from "../classifier/classifier.js";

type BashInput = {
  command: string;
  /** Si es true, saltea el clasificador y ejecuta el comando directamente.
   * Usar solo después de que el usuario confirmó vía ask_user. */
  force?: boolean;
};

export type BashToolOptions = {
  classifier?: CommandClassifier;
};

const TIMEOUT_MS = 30_000; // matar comandos colgados a los 30s
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB de stdout/stderr

// Guardarraíl determinista: patrones que nunca se ejecutan sin importar
// lo que diga el clasificador. Son el safety net para casos donde el LLM
// falle (ej: no detecte un fork bomb o un dd a un disco).
const HARDBLOCK_PATTERNS = [
  /\brm\s+-[a-z]*[rf]/i,              // rm con -r o -f
  /:\s*\(\s*\)\s*\{.*:.*\|.*:.*\}/,    // fork bomb
  />\s*\/dev\/(sd|nvme|disk|hd)/i,     // escritura directa a un disco
  /\bmkfs\b/i,                         // formatear filesystem
  /\bdd\b.*\bof=\/dev\//i,             // dd hacia un device
  /\b(shutdown|reboot|halt|poweroff)\b/i, // apagar/reiniciar la máquina
];

export class BashTool extends Tool<BashInput, string> {
  #classifier?: CommandClassifier;

  constructor(options?: BashToolOptions) {
    super({
      name: "bash",
      description: "Ejecuta un comando bash y devuelve stdout y stderr",
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
        },
        required: ["command"],
      },
    });
    this.#classifier = options?.classifier;
  }

  async execute({ command, force }: BashInput): Promise<string> {
    try {
      if (!command || typeof command !== "string") {
        logger.error("Invalid bash command input", { command });
        return "Error: command must be a non-empty string";
      }

      // ── Guardarraíl determinista ──────────────────────────
      // Bloquea comandos catastróficos incluso si el clasificador
      // los marca como SAFE por error. force: true lo saltea
      // (el usuario ya confirmó explícitamente vía ask_user).
      if (!force && this.isHardblocked(command)) {
        logger.warn("Hardblocked command", { command });
        return [
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
        ].join("\n");
      }

      // ── Clasificación ──────────────────────────────────────────
      if (this.#classifier && !force) {
        const classification = await this.#classifier.classify(command);

        if (classification.verdict === "dangerous") {
          const sourceTag = classification.source === "override"
            ? `override: "${classification.override?.pattern}"`
            : "clasificador Haiku";

          return [
            `BLOQUEADO POR CLASIFICADOR DE SEGURIDAD (${sourceTag})`,
            ``,
            `Comando: ${command}`,
            ``,
            `Razón: ${classification.reason}`,
            ``,
            `INSTRUCCIONES PARA EL AGENTE:`,
            `- No intentes este comando con otra sintaxis o herramienta.`,
            `- Informale al usuario qué comando fue bloqueado y por qué.`,
            `- Si el usuario quiere ejecutarlo igual, usá ask_user para`,
            `  preguntarle explícitamente, y si confirma, volvé a llamar`,
            `  a bash con el mismo comando y el parámetro force: true.`,
          ].join("\n");
        }
      }

      // Si force: true y el aprendizaje está habilitado, registramos el override
      if (this.#classifier && force && this.#classifier.learnEnabled) {
        this.#classifier.learnOverride(command, "safe");
      }

      logger.info("Executing bash command", { command, force });
      const result = await new Promise<string>((resolve, reject) => {
        exec(command, {
          encoding: "buffer" as BufferEncoding,
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
        }, (error, stdout, stderr) => {
          // juntar stdout y stderr
          const out = Buffer.isBuffer(stdout) ? stdout.toString("utf-8") : String(stdout);
          const err = Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr);
          const combined = (out + (err ? err : "")).trim();
          if (error && !combined) {
            reject(error);
          } else {
            resolve(combined || (error?.message ?? ""));
          }
        });
      });
      logger.info("Command executed successfully");
      return result;
    } catch (err: unknown) {
      const error = err as { code?: string; signal?: string; stderr?: string; stdout?: string; message?: string };
      if (error.code === "ETIMEDOUT" || error.signal === "SIGTERM") {
        const msg = `Error: command timed out after ${TIMEOUT_MS}ms`;
        logger.warn("Bash command timed out", { command });
        return msg;
      }
      const errorMsg = error.stderr || error.stdout || error.message || String(err);
      logger.error("Bash command failed", { command, error: errorMsg });
      return errorMsg;
    }
  }

  private isHardblocked(command: string): boolean {
    return HARDBLOCK_PATTERNS.some((p) => p.test(command));
  }
}
