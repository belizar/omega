import { exec } from "child_process";
import { Tool } from "./tool.js";
import { logger } from "../logger.js";
import { CommandClassifier, type ClassifierResult } from "../classifier/classifier.js";

type BashInput = { command: string };

/** Si está presente, BashTool clasifica el comando y pide confirmación antes de ejecutar. */
export type BashConfirmCallback = (command: string, classification: ClassifierResult) => Promise<boolean>;

export type BashToolOptions = {
  classifier?: CommandClassifier;
  onConfirm?: BashConfirmCallback;
};

const TIMEOUT_MS = 30_000; // matar comandos colgados a los 30s
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB de stdout/stderr

// Esto NO es un sandbox: es un guardarraíl best-effort contra los
// errores más groseros. Un comando malicioso decidido lo puede saltar.
// Para aislamiento real haría falta correr en un contenedor/VM.
const BLOCKED_PATTERNS = [
  /\brm\s+-[a-z]*[rf]/i, // rm con -r o -f en cualquier orden/combinación
  /:\s*\(\s*\)\s*\{.*:.*\|.*:.*\}/, // fork bomb
  />\s*\/dev\/(sd|nvme|disk|hd)/i, // escritura directa a un disco
  /\bmkfs\b/i, // formatear un filesystem
  /\bdd\b.*\bof=\/dev\//i, // dd hacia un device
  /\b(shutdown|reboot|halt|poweroff)\b/i, // apagar/reiniciar la máquina
];

// Patrones que involucran archivos .env (lectura o escritura)
const ENV_ACCESS_PATTERNS = [
  /(^|[|&;`\s])(cat|head|tail|less|more|bat|nl|od|strings)\s+.*\.env\b/i,
  /(^|[|&;`\s])(cp|mv)\s+.*\.env\b/i,
  /(^|[|&;`\s])(cp|mv)\s+\S+\s+.*\.env\b/i,
  />>>?\s*.*\.env\b/i,        // > .env, >> .env
  /(^|[|&;`\s])echo\s+.*>>>?\s*.*\.env\b/i,
  /(^|[|&;`\s])tee\s+.*\.env\b/i,
  /(^|[|&;`\s])(grep|rg|awk|sed|cut|sort|uniq|diff|comm|join|paste)\s+.*\.env\b/i,
  /\.env[\s'"]*$/i,            // cualquier comando cuyo último arg sea .env
];

export class BashTool extends Tool<BashInput, string> {
  #classifier?: CommandClassifier;
  #onConfirm?: BashConfirmCallback;

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
        },
        required: ["command"],
      },
    });
    this.#classifier = options?.classifier;
    this.#onConfirm = options?.onConfirm;
  }

  private isCommandBlocked(command: string): boolean {
    return BLOCKED_PATTERNS.some((pattern) => pattern.test(command))
      || ENV_ACCESS_PATTERNS.some((pattern) => pattern.test(command));
  }

  async execute({ command }: BashInput): Promise<string> {
    try {
      if (!command || typeof command !== "string") {
        logger.error("Invalid bash command input", { command });
        return "Error: command must be a non-empty string";
      }

      if (this.isCommandBlocked(command)) {
        logger.warn("Blocked dangerous command", { command });
        return "Error: This command is blocked for security reasons";
      }

      // ── Clasificación ──────────────────────────────────────────
      if (this.#classifier && this.#onConfirm) {
        const classification = await this.#classifier.classify(command);

        if (classification.verdict === "dangerous") {
          const confirmed = await this.#onConfirm(command, classification);

          // Aprender del feedback del usuario
          if (confirmed) {
            await this.#classifier.learnOverride(command, "safe");
          } else {
            await this.#classifier.learnOverride(command, "dangerous");
            return `Error: El usuario rechazó la ejecución del comando: "${command}". Razón del clasificador: ${classification.reason}`;
          }
        }
      }

      logger.info("Executing bash command", { command });
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
}
