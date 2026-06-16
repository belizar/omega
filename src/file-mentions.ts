import { existsSync, readFileSync, statSync } from "fs";
import { resolve, relative, basename } from "path";
import { isEnvFile } from "./tools/env-guard.js";
import { logger } from "./logger.js";

const MAX_FILE_SIZE = 100_000; // ~100KB, para no volar el contexto
const MAX_TOTAL_INJECTED = 200_000; // máximo total entre todos los @files

/**
 * Detecta y expande menciones @file en el mensaje del usuario.
 * Devuelve el texto enriquecido con el contenido de los archivos.
 */
export function expandFileMentions(input: string): { text: string; expandedFiles: string[] } {
  // Regex: @ seguido de un path (con slash o extensión, para distinguir de @usuario)
  // Detecta: @src/file.ts, @./config.json, @../lib/util.js, @src/runner
  // No detecta: @usuario (sin slash ni extensión), email@domain.com
  const mentionRegex = /@([^\s"'`()[\]{};,!?]*(?:\/|\.)[^\s"'`()[\]{};,!?]*)/g;

  const mentions: Array<{ raw: string; path: string; absPath: string }> = [];
  const seen = new Set<string>();

  let match;
  while ((match = mentionRegex.exec(input)) !== null) {
    const rawPath = match[1];
    const absPath = resolve(rawPath);

    if (seen.has(absPath)) continue;
    seen.add(absPath);

    if (!existsSync(absPath)) {
      logger.warn("File mention: path no encontrado", { path: rawPath });
      continue;
    }

    try {
      if (!statSync(absPath).isFile()) {
        logger.warn("File mention: no es un archivo", { path: rawPath });
        continue;
      }
    } catch {
      continue;
    }

    if (isEnvFile(absPath)) {
      logger.warn("File mention: archivo .env bloqueado", { path: rawPath });
      continue;
    }

    mentions.push({ raw: match[0], path: rawPath, absPath });
  }

  if (mentions.length === 0) return { text: input, expandedFiles: [] };

  // Leer archivos y construir el bloque de contexto
  const parts: string[] = [];
  let totalSize = 0;

  for (const m of mentions) {
    try {
      const content = readFileSync(m.absPath, "utf-8");
      const relPath = relative(process.cwd(), m.absPath) || basename(m.absPath);
      const fileHeader = `\n--- ${relPath} ---\n`;
      const fileFooter = `\n--- EOF ${relPath} ---\n`;

      let snippet = content;
      if (snippet.length > MAX_FILE_SIZE) {
        snippet = snippet.slice(0, MAX_FILE_SIZE);
        const truncatedNote = `\n... (archivo truncado, ${content.length} bytes totales, mostrando primeros ${MAX_FILE_SIZE})`;
        totalSize += fileHeader.length + MAX_FILE_SIZE + truncatedNote.length + fileFooter.length;
        if (totalSize > MAX_TOTAL_INJECTED) break;
        parts.push(fileHeader + snippet + truncatedNote + fileFooter);
      } else {
        totalSize += fileHeader.length + content.length + fileFooter.length;
        if (totalSize > MAX_TOTAL_INJECTED) break;
        parts.push(fileHeader + snippet + fileFooter);
      }
    } catch (err) {
      logger.warn("File mention: error al leer archivo", {
        path: m.path,
        error: String(err),
      });
    }
  }

  if (parts.length === 0) return { text: input, expandedFiles: [] };

  const injectedBlock = parts.join("");
  const expandedFiles = mentions.map((m) => relative(process.cwd(), m.absPath) || basename(m.absPath));
  return {
    text: `${input}\n\n[Archivos referenciados con @:]${injectedBlock}`,
    expandedFiles,
  };
}