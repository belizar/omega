import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import { Tool } from "./tool.js";
import { logger } from "../logger.js";
import { isEnvFile, ENV_BLOCK_MESSAGE } from "./env-guard.js";

export type EditInput = {
  path: string;
  oldText?: string;
  newText?: string;
  replaceAll?: boolean;
  /** Línea inicial del rango a reemplazar (1-indexed, inclusive). Úsala como alternativa a oldText. */
  startLine?: number;
  /** Línea final del rango a reemplazar (1-indexed, inclusive). */
  endLine?: number;
  /** Opcional. Array de ediciones a aplicar secuencialmente: [{oldText, newText}, ...].
   *  Alternativa a oldText/newText simple para múltiples cambios en una sola llamada. */
  edits?: Array<{ oldText: string; newText: string }>;
};

// ── helpers ──────────────────────────────────────────────────────────

function getIndent(line: string): number {
  return line.length - line.trimStart().length;
}

/** Bigramas de caracteres de s (minúsculas). Ej: "hola" → ["ho","ol","la"] */
function bigrams(s: string): string[] {
  const t = s.toLowerCase();
  const result: string[] = [];
  for (let i = 0; i < t.length - 1; i++) {
    result.push(t.slice(i, i + 2));
  }
  return result;
}

/** Coeficiente de Sørensen-Dice sobre bigramas de caracteres de dos strings trimmeadas. */
function dice(a: string, b: string): number {
  const ta = a.trim().toLowerCase();
  const tb = b.trim().toLowerCase();
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length <= 1 || tb.length <= 1) {
    // Strings de 0 o 1 char: comparación directa
    return ta === tb ? 1 : 0;
  }
  const ba = bigrams(ta);
  const bb = bigrams(tb);

  const fA = new Map<string, number>();
  const fB = new Map<string, number>();
  for (const bg of ba) fA.set(bg, (fA.get(bg) ?? 0) + 1);
  for (const bg of bb) fB.set(bg, (fB.get(bg) ?? 0) + 1);

  let common = 0;
  const all = new Set([...fA.keys(), ...fB.keys()]);
  for (const bg of all) {
    common += Math.min(fA.get(bg) ?? 0, fB.get(bg) ?? 0);
  }
  return (2 * common) / (ba.length + bb.length);
}

/** Encontrá todos los bloques que matchean oldText línea-por-línea TRIMMEADA. */
function findFlexibleMatches(
  fileLines: string[],
  oldLines: string[],
): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (fileLines[i + j].trim() !== oldLines[j].trim()) {
        match = false;
        break;
      }
    }
    if (match) {
      matches.push({ start: i, end: i + oldLines.length - 1 });
    }
  }
  return matches;
}

/**
 * Re-indenta newText aplicando un delta:
 *   - Si delta > 0 → agrega espacios al inicio de cada línea no vacía.
 *   - Si delta < 0 → quita hasta |delta| espacios del inicio.
 */
function reindent(text: string, delta: number): string {
  if (delta === 0) return text;
  const lines = text.split("\n");
  if (delta > 0) {
    const pad = " ".repeat(delta);
    return lines.map((l) => (l.trim() === "" ? l : pad + l)).join("\n");
  } else {
    const toRemove = -delta;
    return lines
      .map((l) => {
        if (l.trim() === "") return l;
        const spaces = l.length - l.trimStart().length;
        const cut = Math.min(spaces, toRemove);
        return l.slice(cut);
      })
      .join("\n");
  }
}

/**
 * Busca en el archivo la línea más parecida a la primera línea no vacía de oldText.
 * Rankea TODAS las líneas por coeficiente de Sørensen-Dice y devuelve el contexto
 * alrededor de la de mayor puntaje. Siempre devuelve un candidato si el archivo
 * tiene al menos una línea.
 */
function findClosest(
  content: string,
  oldText: string,
): { text: string; lineNum: number; score: number } | null {
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n");

  const firstNonEmpty = oldLines.find((l) => l.trim().length > 0);
  const needle = firstNonEmpty ? firstNonEmpty.trim() : "";

  // Si no hay líneas en el archivo, no podemos mostrar nada
  if (contentLines.length === 0) return null;

  // Archivo completamente vacío (todas las líneas vacías)
  const hasContent = contentLines.some((l) => l.trim().length > 0);
  if (!hasContent) return null;

  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < contentLines.length; i++) {
    const trimmed = contentLines[i].trim();
    if (trimmed.length === 0) continue;
    const s = dice(needle, trimmed);
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }

  // Si encontramos al menos una línea no vacía, bestScore >= 0
  if (bestScore < 0) return null;

  return {
    text: formatContext(contentLines, bestIdx),
    lineNum: bestIdx + 1,
    score: bestScore,
  };
}

function formatContext(lines: string[], center: number): string {
  const start = Math.max(0, center - 1);
  const end = Math.min(lines.length - 1, center + 1);
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const marker = i === center ? "   ← más parecida" : "";
    out.push(`  ${String(i + 1).padStart(4, " ")} | ${lines[i]}${marker}`);
  }
  return out.join("\n");
}

/** Devuelve los números de línea de cada ocurrencia de `search` en `content`. */
function findOccurrenceLines(content: string, search: string): number[] {
  const linums: number[] = [];
  let pos = 0;
  while (pos < content.length) {
    const idx = content.indexOf(search, pos);
    if (idx === -1) break;
    linums.push(content.slice(0, idx).split("\n").length);
    pos = idx + 1; // avanzar al menos 1 char
  }
  return linums;
}

// ── tool ─────────────────────────────────────────────────────────────

export class EditTool extends Tool<EditInput, string> {
  /** cwd contra el que se resuelven paths relativos (default: el del proceso). */
  #cwd: string;

  constructor(cwd: string = process.cwd()) {
    super({
      name: "edit",
      description:
        "Reemplaza quirúrgicamente texto exacto dentro de un archivo, o aplica múltiples ediciones de una vez (modo edits). Cuando necesites varios cambios en un mismo archivo, usá el array edits en vez de llamar a edit varias veces.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ruta del archivo a editar" },
          oldText: {
            type: "string",
            description:
              "Texto exacto a reemplazar (debe matchear carácter por carácter, incluido el whitespace). Usalo solo si necesitás match exacto; para reemplazar por rango usá startLine/endLine.",
          },
          newText: {
            type: "string",
            description: "Texto nuevo que reemplaza al viejo",
          },
          replaceAll: {
            type: "boolean",
            description:
              "Opcional. Si es true y hay más de una ocurrencia de oldText, reemplaza todas en vez de fallar.",
          },
          startLine: {
            type: "number",
            description:
              "Opcional. Línea inicial del rango a reemplazar (1-indexed, inclusive). Alternativa a oldText para editar por rango sin necesidad de match exacto.",
          },
          endLine: {
            type: "number",
            description:
              "Opcional. Línea final del rango a reemplazar (1-indexed, inclusive). Debe usarse junto con startLine.",
          },
          edits: {
            type: "array",
            description:
              "Opcional. Array de ediciones a aplicar secuencialmente al mismo archivo. Cada elemento tiene {oldText, newText}. Las ediciones se aplican una tras otra sobre el resultado de la anterior. Útil cuando necesitás varios cambios quirúrgicos en un archivo en una sola llamada.",
            items: {
              type: "object",
              properties: {
                oldText: { type: "string", description: "Texto exacto a reemplazar" },
                newText: {
                  type: "string",
                  description: "Texto nuevo que reemplaza al viejo",
                },
              },
              required: ["oldText", "newText"],
            },
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
        throw new Error(
          "Input must be an object with path, and either oldText+newText, startLine+endLine, or edits array",
        );
      }

      const { path, oldText, newText, replaceAll, startLine, endLine, edits } =
        input as EditInput;

      if (typeof path !== "string") {
        throw new Error("path must be a string");
      }

      // ── Modo edits (array de múltiples ediciones) ──
      if (Array.isArray(edits) && edits.length > 0) {
        return this.#executeMultiEdit(path, edits);
      }

      if (typeof newText !== "string") {
        throw new Error(
          "newText must be a string (or use edits array)",
        );
      }

      // Validación: o oldText, o startLine+endLine (pero no ambos ni ninguno)
      const hasOldText = typeof oldText === "string";
      const hasRange =
        typeof startLine === "number" && typeof endLine === "number";

      if (!hasOldText && !hasRange) {
        throw new Error(
          "Debe especificar oldText o startLine/endLine (rango de líneas).",
        );
      }

      if (hasOldText && hasRange) {
        // Si ambos: validamos que oldText matchee el rango indicado
        isEnvFileGuard(path);
        const content = await readFileOrThrow(resolve(this.#cwd, path));
        const fileLines = content.split("\n");
        if (startLine < 1 || endLine > fileLines.length || startLine > endLine) {
          return `Error: startLine=${startLine}, endLine=${endLine} fuera de rango (1-${fileLines.length}).`;
        }
        const rangeText = fileLines.slice(startLine - 1, endLine).join("\n");
        if (rangeText !== oldText) {
          return (
            `Error: oldText no coincide con las líneas ${startLine}-${endLine}. ` +
            `Usá read para verificar el contenido actual, o usá solo startLine/endLine sin oldText.`
          );
        }
        return this.#replaceRange(path, fileLines, startLine, endLine, newText);
      }

      if (isEnvFile(path)) {
        logger.warn("Blocked edit of env file", { path });
        return ENV_BLOCK_MESSAGE;
      }

      // ── Modo rango (startLine/endLine sin oldText) ──
      if (hasRange) {
        const content = await readFileOrThrow(resolve(this.#cwd, path));
        const fileLines = content.split("\n");
        if (startLine < 1 || endLine > fileLines.length || startLine > endLine) {
          return `Error: startLine=${startLine}, endLine=${endLine} fuera de rango (archivo tiene ${fileLines.length} líneas).`;
        }
        return this.#replaceRange(path, fileLines, startLine, endLine, newText);
      }

      // ── Modo oldText (existente) ──
      return await this.#executeSingleEdit(path, oldText as string, newText, replaceAll);
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error ? err.message : `Unknown error editing file`;
      logger.error(errorMsg, { error: err });
      return `Error: ${errorMsg}`;
    }
  }

  /** Ejecuta un único reemplazo oldText → newText con match flexible y feedback de error. */
  async #executeSingleEdit(
    path: string,
    oldText: string,
    newText: string,
    replaceAll?: boolean,
  ): Promise<string> {
    logger.info("Editing file", {
      path,
      oldTextLength: oldText.length,
      newTextLength: newText.length,
    });

    let content: string;
    content = await readFileOrThrow(resolve(this.#cwd, path));

    const occurrences = content.split(oldText).length - 1;

    // ── 0 ocurrencias exactas → probar flexible → mostrar match más cercano ──
    if (occurrences === 0) {
      return this.#handleNoMatch(path, content, oldText, newText);
    }

    // ── Múltiples ocurrencias ──
    if (occurrences > 1) {
      if (replaceAll) {
        const updated = content.split(oldText).join(newText);
        await writeFile(resolve(this.#cwd, path),updated, "utf-8");
        logger.info("File edited (replaceAll)", { path, occurrences });
        return `Editado ${path} correctamente (${occurrences} ocurrencias reemplazadas).`;
      }

      const linums = findOccurrenceLines(content, oldText);
      logger.warn("Multiple occurrences found", { path, occurrences, linums });
      return (
        `El texto aparece ${occurrences} veces en ${path}, es ambiguo. ` +
        `Ocurrencias en líneas: ${linums.join(", ")}.\n` +
        `Incluí más contexto en oldText para que sea único, o usá replaceAll: true ` +
        `para reemplazar todas las ocurrencias, o usá startLine/endLine para especificar el rango.`
      );
    }

    // ── Exactamente 1 ocurrencia ──
    const updated = content.replace(oldText, newText);
    await writeFile(resolve(this.#cwd, path),updated, "utf-8");
    logger.info("File edited successfully", { path });
    return `Editado ${path} correctamente.`;
  }

  /** Maneja el caso de 0 matches exactos: prueba flexible, luego findClosest. */
  async #handleNoMatch(
    path: string,
    content: string,
    oldText: string,
    newText: string,
  ): Promise<string> {
    const fileLines = content.split("\n");
    const oldLines = oldText.split("\n");
    const flexibleMatches = findFlexibleMatches(fileLines, oldLines);

    if (flexibleMatches.length === 1) {
      const match = flexibleMatches[0];
      const fileIndent = getIndent(fileLines[match.start]);
      const oldIndent = getIndent(oldLines[0]);
      const delta = fileIndent - oldIndent;
      const indentedNewText = reindent(newText, delta);

      const before = fileLines.slice(0, match.start).join("\n");
      const after = fileLines.slice(match.end + 1).join("\n");
      const updated =
        [before, indentedNewText, after].filter((s) => s !== "").join("\n") ||
        indentedNewText;

      await writeFile(resolve(this.#cwd, path),updated, "utf-8");
      logger.info("File edited (flexible match)", { path, delta });
      return `Editado ${path} correctamente (match flexible, delta indentación: ${delta > 0 ? "+" : ""}${delta}).`;
    }

    const similar = findClosest(content, oldText);
    if (similar) {
      const prefix =
        similar.score < 0.2
          ? `No encontré el texto exacto en ${path}. ` +
            `Lo más parecido que encontré (puede no ser lo que buscás) ` +
            `está cerca de la línea ${similar.lineNum}:`
          : `No encontré el texto exacto en ${path}. ` +
            `Lo más parecido está cerca de la línea ${similar.lineNum}:`;
      logger.warn("Text not found; showing closest block", {
        path,
        score: similar.score,
      });
      return (
        `${prefix}\n\n${similar.text}\n\n` +
        `Reintentá el edit copiando el texto EXACTO de ahí (incluida la indentación), o usá startLine/endLine para reemplazar por rango.`
      );
    }

    logger.warn("Text not found in file", { path });
    return (
      `Text to replace not found in ${path}. The file appears to be empty. ` +
        `Usá read para revisar el contenido actual del archivo.`
    );
  }

  /** Aplica múltiples ediciones secuencialmente al mismo archivo. */
  async #executeMultiEdit(
    path: string,
    edits: Array<{ oldText: string; newText: string }>,
  ): Promise<string> {
    if (isEnvFile(path)) {
      logger.warn("Blocked multi-edit of env file", { path });
      return ENV_BLOCK_MESSAGE;
    }

    logger.info("Multi-editing file", { path, editCount: edits.length });

    let content: string;
    try {
      content = await readFileOrThrow(resolve(this.#cwd, path));
    } catch (err: unknown) {
      if (err instanceof Error) throw err;
      throw new Error(`Could not read ${path}: ${String(err)}`);
    }

    const results: string[] = [];
    let current = content;

    for (let i = 0; i < edits.length; i++) {
      const { oldText, newText } = edits[i];
      const occurrences = current.split(oldText).length - 1;

      if (occurrences === 0) {
        // Intentar match flexible
        const fileLines = current.split("\n");
        const oldLines = oldText.split("\n");
        const flexibleMatches = findFlexibleMatches(fileLines, oldLines);

        if (flexibleMatches.length === 1) {
          const match = flexibleMatches[0];
          const fileIndent = getIndent(fileLines[match.start]);
          const oldIndent = getIndent(oldLines[0]);
          const delta = fileIndent - oldIndent;
          const indentedNewText = reindent(newText, delta);

          const before = fileLines.slice(0, match.start).join("\n");
          const after = fileLines.slice(match.end + 1).join("\n");
          current =
            [before, indentedNewText, after]
              .filter((s) => s !== "")
              .join("\n") || indentedNewText;
          results.push(
            `Edit #${i + 1}: OK (flexible, delta=${delta > 0 ? "+" : ""}${delta})`,
          );
          continue;
        }

        const similar = findClosest(current, oldText);
        if (similar) {
          return (
            `Error en edit #${i + 1} de ${edits.length}: ` +
            `no encontré "${oldText.slice(0, 60)}${oldText.length > 60 ? "..." : ""}" en ${path}. ` +
            `Lo más parecido está cerca de la línea ${similar.lineNum}:\n\n` +
            `${similar.text}\n\n` +
            `No se aplicó ninguna edición. Releé el archivo y reintentá.`
          );
        }
        return (
          `Error en edit #${i + 1} de ${edits.length}: ` +
          `"${oldText.slice(0, 60)}${oldText.length > 60 ? "..." : ""}" no encontrado en ${path}. ` +
          `No se aplicó ninguna edición.`
        );
      }

      if (occurrences > 1) {
        const linums = findOccurrenceLines(current, oldText);
        return (
          `Error en edit #${i + 1} de ${edits.length}: ` +
          `el texto aparece ${occurrences} veces en ${path}, es ambiguo. ` +
          `Ocurrencias en líneas: ${linums.join(", ")}.\n` +
          `Incluí más contexto en oldText para que sea único. ` +
          `No se aplicó ninguna edición.`
        );
      }

      // 1 ocurrencia exacta
      current = current.replace(oldText, newText);
      results.push(`Edit #${i + 1}: OK`);
    }

    await writeFile(resolve(this.#cwd, path),current, "utf-8");
    logger.info("Multi-edit completed", { path, count: edits.length });
    return (
      `Editado ${path} correctamente (${edits.length} ediciones):\n` +
      results.join("\n")
    );
  }

  /** Reemplaza líneas startLine a endLine (1-indexed, inclusive) por newText. */
  async #replaceRange(
    path: string,
    fileLines: string[],
    startLine: number,
    endLine: number,
    newText: string,
  ): Promise<string> {
    const before = fileLines.slice(0, startLine - 1);
    const after = fileLines.slice(endLine);
    const updated =
      [...before, newText, ...after].filter((s) => s !== "").join("\n") ||
      newText;
    await writeFile(resolve(this.#cwd, path),updated, "utf-8");
    logger.info("File edited (range)", { path, startLine, endLine });
    return `Editado ${path} correctamente (líneas ${startLine}-${endLine}).`;
  }
}

/** Lee un archivo o tira error descriptivo. */
async function readFileOrThrow(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (err: unknown) {
    throw new Error(
      `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Guardrail de env file, tira si es .env. */
function isEnvFileGuard(path: string): void {
  if (isEnvFile(path)) {
    throw new Error(ENV_BLOCK_MESSAGE);
  }
}