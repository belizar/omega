import { readFile } from "fs/promises";
import { Tool, ToolResult } from "./tool.js";
import { logger } from "../logger.js";
import { isEnvFile, ENV_BLOCK_MESSAGE } from "./env-guard.js";

type ReadInput = { path: string; offset?: number; limit?: number };

export class ReadTool extends Tool<ReadInput, ToolResult> {
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

  async execute(input: unknown): Promise<ToolResult> {
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
        return { output: ENV_BLOCK_MESSAGE };
      }

      logger.info("Reading file", { path, offset, limit });
      const content = await readFile(path, "utf-8");

      if (offset === undefined && limit === undefined) {
        logger.info("File read successfully", { path, lines: content.split("\n").length });
        return { output: content };
      }

      const lines = content.split("\n");
      const start = offset ? offset - 1 : 0;
      const end = limit ? start + limit : lines.length;
      const result = lines.slice(start, end).join("\n");
      logger.info("File slice read successfully", { path, start, end });
      return { output: result };
    } catch (err: unknown) {
      const pathName =
        input !== null && typeof input === "object" && "path" in (input as any)
          ? String((input as any).path)
          : String(input);
      const errorMsg = `Error reading ${pathName}: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(errorMsg);
      return { output: errorMsg };
    }
  }
}
