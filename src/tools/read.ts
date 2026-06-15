import { readFileSync } from "fs";
import { Tool } from "./tool.js";
import { logger } from "../logger.js";
import { isEnvFile, ENV_BLOCK_MESSAGE } from "./env-guard.js";

type ReadInput = { path: string; offset?: number; limit?: number };

export class ReadTool extends Tool<ReadInput, string> {
  constructor() {
    super({
      name: "read",
      description: "Devuelve el contenido de un archivo",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ruta del archivo a leer" },
          offset: {
            type: "number",
            description: "Línea desde la que empezar (1-indexed, opcional)",
          },
          limit: {
            type: "number",
            description: "Máximo de líneas a leer (opcional)",
          },
        },
        required: ["path"],
      },
    });
  }

  execute(input: unknown): string {
    try {
      if (typeof input !== "object" || input === null) {
        throw new Error("Input must be an object with path");
      }

      const { path, offset, limit } = input as ReadInput;

      if (typeof path !== "string" || !path.trim()) {
        throw new Error("path must be a non-empty string");
      }

      if (isEnvFile(path)) {
        logger.warn("Blocked read of env file", { path });
        return ENV_BLOCK_MESSAGE;
      }

      logger.info("Reading file", { path, offset, limit });
      const content = readFileSync(path, "utf-8");

      // sin offset/limit: devolvemos el archivo entero
      if (offset === undefined && limit === undefined) {
        logger.info("File read successfully", { path, lines: content.split("\n").length });
        return content;
      }

      const lines = content.split("\n");
      const start = offset ? offset - 1 : 0; // offset es 1-indexed
      const end = limit ? start + limit : lines.length;
      const result = lines.slice(start, end).join("\n");
      logger.info("File slice read successfully", { path, start, end });
      return result;
    } catch (err: unknown) {
      const pathName = input !== null && typeof input === "object" && "path" in (input as object)
        ? String((input as ReadInput).path)
        : String(input);
      const errorMsg = `Error reading ${pathName}: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(errorMsg);
      return errorMsg;
    }
  }
}
