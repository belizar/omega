import { readFile, writeFile } from "fs/promises";
import { Tool } from "./tool.js";
import { logger } from "../logger.js";
import { isEnvFile, ENV_BLOCK_MESSAGE } from "./env-guard.js";

export type EditInput = {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
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
          replaceAll: {
            type: "boolean",
            description:
              "Opcional. Si es true y hay más de una ocurrencia de oldText, reemplaza todas en vez de fallar.",
          },
        },
        required: ["path", "oldText", "newText"],
      },
    });
  }

  async execute(input: unknown): Promise<string> {
    try {
      if (typeof input !== "object" || input === null) {
        throw new Error("Input must be an object with path, oldText, and newText");
      }

      const { path, oldText, newText, replaceAll } = input as EditInput;

      if (typeof path !== "string" || typeof oldText !== "string" || typeof newText !== "string") {
        throw new Error("path, oldText, and newText must be strings");
      }

      if (isEnvFile(path)) {
        logger.warn("Blocked edit of env file", { path });
        return ENV_BLOCK_MESSAGE;
      }

      logger.info("Editing file", { path, oldTextLength: oldText.length, newTextLength: newText.length });

      let content: string;
      try {
        content = await readFile(path, "utf-8");
      } catch (err: unknown) {
        throw new Error(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }

      const occurrences = content.split(oldText).length - 1;

      // ── CAMBIO 2: si 0 ocurrencias exactas, probar flexible ──
      if (occurrences === 0) {
        const fileLines = content.split("\n");
        const oldLines = oldText.split("\n");
        const flexibleMatches = findFlexibleMatches(fileLines, oldLines);

        if (flexibleMatches.length === 1) {
          // Una sola coincidencia flexible → aplicar con reindentación
          const match = flexibleMatches[0];
          const fileIndent = getIndent(fileLines[match.start]);
          const oldIndent = getIndent(oldLines[0]);
          const delta = fileIndent - oldIndent;
          const indentedNewText = reindent(newText, delta);

          const before = fileLines.slice(0, match.start).join("\n");
          const after = fileLines.slice(match.end + 1).join("\n");
          const updated = [before, indentedNewText, after].filter((s) => s !== "").join("\n") ||
            indentedNewText;

          await writeFile(path, updated, "utf-8");
          logger.info("File edited (flexible match)", { path, delta });
          return `Editado ${path} correctamente (match flexible, delta indentación: ${delta > 0 ? "+" : ""}${delta}).`;
        }

        // ── CAMBIO 1: fallo que enseña ──
        const similar = findClosest(content, oldText);
        if (similar) {
          const prefix =
            similar.score < 0.2
              ? `No encontré el texto exacto en ${path}. ` +
                `Lo más parecido que encontré (puede no ser lo que buscás) ` +
                `está cerca de la línea ${similar.lineNum}:`
              : `No encontré el texto exacto en ${path}. ` +
                `Lo más parecido está cerca de la línea ${similar.lineNum}:`;
          logger.warn("Text not found; showing closest block", { path, score: similar.score });
          return `${prefix}\n\n${similar.text}\n\n` +
            `Reintentá el edit copiando el texto EXACTO de ahí (incluida la indentación).`;
        }

        // Nada parecido (archivo vacío)
        logger.warn("Text not found in file", { path });
        throw new Error(
          `Text to replace not found in ${path}. The file appears to be empty. ` +
            `Usá read para revisar el contenido actual del archivo.`,
        );
      }

      // ── Múltiples ocurrencias ──
      if (occurrences > 1) {
        if (replaceAll) {
          // CAMBIO 4: replaceAll
          const updated = content.split(oldText).join(newText);
          await writeFile(path, updated, "utf-8");
          logger.info("File edited (replaceAll)", { path, occurrences });
          return `Editado ${path} correctamente (${occurrences} ocurrencias reemplazadas).`;
        }

        // Error con números de línea (CAMBIO 1 — parte de >1)
        const linums = findOccurrenceLines(content, oldText);
        logger.warn("Multiple occurrences found", { path, occurrences, linums });
        return (
          `El texto aparece ${occurrences} veces en ${path}, es ambiguo. ` +
          `Ocurrencias en líneas: ${linums.join(", ")}.\n` +
          `Incluí más contexto en oldText para que sea único, o usá replaceAll: true ` +
          `para reemplazar todas las ocurrencias.`
        );
      }

      // ── Exactamente 1 ocurrencia ──
      const updated = content.replace(oldText, newText);
      try {
        await writeFile(path, updated, "utf-8");
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
