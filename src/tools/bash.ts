import { execSync } from "child_process";
import { Tool } from "./tool.js";
import { logger } from "../logger.js";

type BashInput = { command: string };

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

export class BashTool extends Tool<BashInput, string> {
  constructor() {
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
  }

  private isCommandBlocked(command: string): boolean {
    return BLOCKED_PATTERNS.some((pattern) => pattern.test(command));
  }

  execute({ command }: BashInput): string {
    try {
      if (!command || typeof command !== "string") {
        logger.error("Invalid bash command input", { command });
        return "Error: command must be a non-empty string";
      }

      if (this.isCommandBlocked(command)) {
        logger.warn("Blocked dangerous command", { command });
        return "Error: This command is blocked for security reasons";
      }

      logger.info("Executing bash command", { command });
      const result = execSync(command, {
        encoding: "utf-8",
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      logger.info("Command executed successfully");
      return result;
    } catch (err: any) {
      if (err.code === "ETIMEDOUT" || err.signal === "SIGTERM") {
        const msg = `Error: command timed out after ${TIMEOUT_MS}ms`;
        logger.warn("Bash command timed out", { command });
        return msg;
      }
      const errorMsg = err.stderr || err.stdout || err.message;
      logger.error("Bash command failed", { command, error: errorMsg });
      return errorMsg;
    }
  }
}
