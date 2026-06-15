import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { Tool } from "./tool.js";
import { logger } from "../logger.js";
import { isEnvFile, ENV_BLOCK_MESSAGE } from "./env-guard.js";

type WriteInput = { path: string; content: string };

export class WriteTool extends Tool<WriteInput, string> {
  constructor() {
    super({
      name: "write",
      description:
        "Crea un archivo nuevo o sobrescribe uno existente con el contenido dado",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ruta del archivo a escribir" },
          content: {
            type: "string",
            description: "Contenido completo a escribir en el archivo",
          },
        },
        required: ["path", "content"],
      },
    });
  }

  execute(input: unknown): string {
    try {
      // Validar que input es un objeto
      if (typeof input !== "object" || input === null) {
        throw new Error("Input must be an object with path and content");
      }

      const { path, content } = input as Record<string, unknown>;

      // Validar tipos
      if (typeof path !== "string" || typeof content !== "string") {
        throw new Error("path and content must be strings");
      }

      if (!path.trim()) {
        throw new Error("path cannot be empty");
      }

      if (isEnvFile(path)) {
        logger.warn("Blocked write to env file", { path });
        return ENV_BLOCK_MESSAGE;
      }

      logger.info("Writing file", { path, size: content.length });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf-8");
      logger.info("File written successfully", { path });
      return `Escrito ${path} correctamente.`;
    } catch (err: unknown) {
      const errorMsg = `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(errorMsg, { error: err });
      return errorMsg;
    }
  }
}
