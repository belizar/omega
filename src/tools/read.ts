import { readFile } from "fs/promises";
import { extname } from "path";
import { Tool } from "./tool.js";
import { logger } from "../logger.js";
import { isEnvFile, ENV_BLOCK_MESSAGE } from "./env-guard.js";
import { outlineFile } from "../outline/extract.js";

type ReadInput = {
  path: string;
  offset?: number;
  limit?: number;
  full?: boolean;
};

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export class ReadTool extends Tool<ReadInput, string> {
  #outlineThreshold: number;

  constructor(outlineThreshold: number) {
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
          full: {
            type: "boolean",
            description:
              "Opcional. Si es true, lee el archivo entero aún si es grande (escape hatch del empujón estructural).",
          },
        },
        required: ["path"],
      },
    });
    this.#outlineThreshold = outlineThreshold;
  }

  async execute(input: unknown): Promise<string> {
    try {
      if (typeof input !== "object" || input === null) {
        throw new Error("Input must be an object with path");
      }

      const { path, offset, limit, full } = input as ReadInput;

      if (typeof path !== "string" || !path.trim()) {
        throw new Error("path must be a non-empty string");
      }

      if (isEnvFile(path)) {
        logger.warn("Blocked read of env file", { path });
        return ENV_BLOCK_MESSAGE;
      }

      logger.info("Reading file", { path, offset, limit, full });
      const content = await readFile(path, "utf-8");
      const totalLines = content.split("\n").length;
      const ext = extname(path);

      // Empujón estructural: si es TS/JS, grande, sin offset/limit, y sin full:true
      if (
        !offset &&
        !limit &&
        !full &&
        TS_EXTENSIONS.has(ext) &&
        totalLines > this.#outlineThreshold
      ) {
        logger.info("Outline push for large file", {
          path,
          lines: totalLines,
        });
        const outline = outlineFile(path, content);
        return (
          outline +
          `\n\n— Este archivo tiene ${totalLines} líneas. No lo leas entero: pedí read con offset y` +
          ` limit del rango que necesites (los rangos [a-b] del outline calzan directo).`
        );
      }

      // sin offset/limit: devolvemos el archivo entero
      if (offset === undefined && limit === undefined) {
        logger.info("File read successfully", {
          path,
          lines: totalLines,
        });
        return content;
      }

      const lines = content.split("\n");
      const start = offset ? offset - 1 : 0; // offset es 1-indexed
      const end = limit ? start + limit : lines.length;
      const result = lines.slice(start, end).join("\n");
      logger.info("File slice read successfully", { path, start, end });
      return result;
    } catch (err: unknown) {
      const pathName =
        input !== null && typeof input === "object" && "path" in (input as object)
          ? String((input as ReadInput).path)
          : String(input);
      const errorMsg = `Error reading ${pathName}: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(errorMsg);
      return errorMsg;
    }
  }
}