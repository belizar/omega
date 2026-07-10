import { statSync, readFileSync } from "fs";
import { resolve } from "path";
import { Tool } from "./tool.js";
import { logger } from "../logger.js";
import { isEnvFile, ENV_BLOCK_MESSAGE } from "./env-guard.js";
import { outlineFile, outlineDir } from "../tools/outline-extract.js";

type OutlineInput = { path: string };

export class OutlineTool extends Tool<OutlineInput, string> {
  /** cwd contra el que se resuelven paths relativos (default: el del proceso). */
  #cwd: string;

  constructor(cwd: string = process.cwd()) {
    super({
      name: "outline",
      description:
        "Muestra la estructura (firmas + rangos de línea) de un archivo TS/JS sin los cuerpos, o un mapa de exports de un directorio. Usalo antes de leer un archivo grande: outline para encontrar, read del rango para tocar.",
      schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Ruta del archivo o directorio a analizar",
          },
        },
        required: ["path"],
      },
    });
    this.#cwd = cwd;
  }

  async execute(input: unknown): Promise<string> {
    try {
      if (typeof input !== "object" || input === null) {
        throw new Error("Input must be an object with path");
      }

      const { path } = input as OutlineInput;

      if (typeof path !== "string" || !path.trim()) {
        throw new Error("path must be a non-empty string");
      }

      if (isEnvFile(path)) {
        logger.warn("Blocked outline of env file", { path });
        return ENV_BLOCK_MESSAGE;
      }

      const target = resolve(this.#cwd, path);
      const s = statSync(target);
      if (s.isDirectory()) {
        return outlineDir(target);
      }
      if (s.isFile()) {
        logger.info("Outlining file", { path });
        const content = readFileSync(target, "utf-8");
        return outlineFile(target, content);
      }

      return `Error: ${path} no es ni archivo ni directorio`;
    } catch (err: unknown) {
      const pathName =
        input !== null && typeof input === "object" && "path" in input
          ? String((input as OutlineInput).path)
          : String(input);
      const errorMsg = `Error en outline de ${pathName}: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(errorMsg);
      return errorMsg;
    }
  }
}