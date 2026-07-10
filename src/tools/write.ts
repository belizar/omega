import { writeFile, mkdir, readFile } from "fs/promises";
import { dirname, resolve } from "path";
import { Tool } from "./tool.js";
import { logger } from "../logger.js";
import { isEnvFile, ENV_BLOCK_MESSAGE } from "./env-guard.js";

type WriteInput = { path: string; content: string; overwrite?: boolean };

/**
 * Calcula similitud entre dos textos por líneas (coefficiente de Sørensen-Dice).
 * similitud = 2 * |intersección| / (|A| + |B|)
 * donde la intersección cuenta la mínima cantidad compartida por línea única.
 */
function lineSimilarity(a: string, b: string): number {
  const aLines = a.split("\n");
  const bLines = b.split("\n");

  // Contar frecuencias por línea
  const freqA = new Map<string, number>();
  const freqB = new Map<string, number>();

  for (const l of aLines) freqA.set(l, (freqA.get(l) ?? 0) + 1);
  for (const l of bLines) freqB.set(l, (freqB.get(l) ?? 0) + 1);

  // Intersección: sumar min(countA, countB) para cada línea única
  let common = 0;
  const allLines = new Set([...freqA.keys(), ...freqB.keys()]);
  for (const l of allLines) {
    common += Math.min(freqA.get(l) ?? 0, freqB.get(l) ?? 0);
  }

  const total = aLines.length + bLines.length;
  if (total === 0) return 1;
  return (2 * common) / total;
}

export class WriteTool extends Tool<WriteInput, string> {
  /** cwd contra el que se resuelven paths relativos (default: el del proceso). */
  #cwd: string;

  constructor(cwd: string = process.cwd()) {
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
          overwrite: {
            type: "boolean",
            description:
              "Opcional. Si es true, saltea el chequeo de similitud y sobrescribe el archivo existente sin advertencia.",
          },
        },
        required: ["path", "content"],
      },
    });
    this.#cwd = cwd;
  }

  async execute(input: unknown): Promise<string> {
    try {
      if (typeof input !== "object" || input === null) {
        throw new Error("Input must be an object with path and content");
      }

      const { path, content, overwrite } = input as Record<string, unknown>;

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

      const filePath = resolve(this.#cwd, path);

      // ¿El archivo ya existe?
      let oldContent: string | null = null;
      try {
        oldContent = await readFile(filePath, "utf-8");
      } catch {
        // No existe → archivo nuevo, write normal
        logger.info("Writing new file", { path, size: content.length });
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, content, "utf-8");
        logger.info("File written successfully", { path });
        return `Escrito ${path} correctamente.`;
      }

      // El archivo existe — chequeo de similitud
      if (overwrite === true) {
        logger.info("Overwriting file (overwrite flag)", { path, size: content.length });
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, content, "utf-8");
        logger.info("File overwritten successfully", { path });
        return `Sobrescrito ${path} correctamente (overwrite: true).`;
      }

      const similarity = lineSimilarity(oldContent, content);

      if (similarity > 0.7) {
        const pct = (similarity * 100).toFixed(0);
        logger.warn("Write rejected: content too similar", { path, similarity: pct });
        return (
          `El archivo ${path} ya existe y tu cambio es chico ` +
          `(${pct}% de las líneas son iguales). ` +
          `Usá \`edit\` para cambios quirúrgicos. ` +
          `Si de verdad querés reescribir todo, pasá overwrite: true.`
        );
      }

      // Poca similitud → es un archivo realmente distinto, permitir
      logger.info("Overwriting file (low similarity)", { path, similarity: (similarity * 100).toFixed(0) });
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf-8");
      logger.info("File overwritten successfully", { path });
      return `Sobrescrito ${path} correctamente (baja similitud con el anterior).`;
    } catch (err: unknown) {
      const errorMsg = `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(errorMsg, { error: err });
      return errorMsg;
    }
  }
}
