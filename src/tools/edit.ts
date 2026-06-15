import { readFileSync, writeFileSync } from "fs";
import { Tool } from "./tool.js";
import { logger } from "../logger.js";

type EditInput = { path: string; oldText: string; newText: string };

export class EditTool extends Tool<EditInput, string> {
  constructor() {
    super({
      name: "edit",
      description: "Reemplaza quirúrgicamente texto exacto dentro de un archivo",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ruta del archivo a editar" },
          oldText: {
            type: "string",
            description:
              "Texto exacto a reemplazar (debe matchear carácter por carácter, incluido el whitespace)",
          },
          newText: {
            type: "string",
            description: "Texto nuevo que reemplaza al viejo",
          },
        },
        required: ["path", "oldText", "newText"],
      },
    });
  }

  execute(input: unknown): string {
    try {
      if (typeof input !== "object" || input === null) {
        throw new Error("Input must be an object with path, oldText, and newText");
      }

      const { path, oldText, newText } = input as EditInput;

      if (typeof path !== "string" || typeof oldText !== "string" || typeof newText !== "string") {
        throw new Error("path, oldText, and newText must be strings");
      }

      logger.info("Editing file", { path, oldTextLength: oldText.length, newTextLength: newText.length });

      let content: string;
      try {
        content = readFileSync(path, "utf-8");
      } catch (err: unknown) {
        throw new Error(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }

      const occurrences = content.split(oldText).length - 1;

      if (occurrences === 0) {
        logger.warn("Text not found in file", { path });
        throw new Error(`Text to replace not found in ${path}. Ensure it matches exactly.`);
      }

      if (occurrences > 1) {
        logger.warn("Multiple occurrences found", { path, occurrences });
        throw new Error(`Text appears ${occurrences} times in ${path}, ambiguous. Include more context.`);
      }

      const updated = content.replace(oldText, newText);
      try {
        writeFileSync(path, updated, "utf-8");
      } catch (err: unknown) {
        throw new Error(`Could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }

      logger.info("File edited successfully", { path });
      return `Editado ${path} correctamente.`;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : `Unknown error editing file`;
      logger.error(errorMsg, { error: err });
      return `Error: ${errorMsg}`;
    }
  }
}
