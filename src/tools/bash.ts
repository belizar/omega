import { execSync } from "child_process";
import { Tool } from "./tool.js";
import { logger } from "../logger.js";

type BashInput = { command: string };

// Comandos peligrosos que no se permiten
const BLOCKED_PATTERNS = [
  /rm\s+(-[rf]*\s+)?\//, // rm -rf / pattern
  /:\(\)\s*{\s*:\|:/, // fork bomb pattern
  />\s*\/dev\/sda/, // writing to disk
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
      const result = execSync(command, { encoding: "utf-8" });
      logger.info("Command executed successfully");
      return result;
    } catch (err: any) {
      const errorMsg = err.stderr || err.stdout || err.message;
      logger.error("Bash command failed", { command, error: errorMsg });
      return errorMsg;
    }
  }
}
