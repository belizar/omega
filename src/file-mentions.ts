import { existsSync, readFileSync, statSync } from "fs";
import { resolve, relative, basename } from "path";
import { isEnvFile } from "./tools/env-guard.js";
import { ImageMessage } from "./message.js";
import { logger } from "./logger.js";

const MAX_FILE_SIZE = 100_000; // ~100KB, para no volar el contexto
const MAX_TOTAL_INJECTED = 200_000; // máximo total entre todos los @files
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB máximo por imagen

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

type MentionResult = {
  text: string;
  expandedFiles: string[];
  images: ImageMessage[];
};

function isImageFile(path: string): boolean {
  const ext = path.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  return ext ? ext in IMAGE_EXTENSIONS : false;
}

function getImageMediaType(path: string): string {
  const ext = path.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  return ext ? IMAGE_EXTENSIONS[ext] ?? "image/png" : "image/png";
}

/**
 * Detecta y expande menciones @file en el mensaje del usuario.
 * Detecta archivos de texto (inyecta contenido) e imágenes (convierte a base64).
 */
export function expandFileMentions(input: string): MentionResult {
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

  if (mentions.length === 0) return { text: input, expandedFiles: [], images: [] };

  // Separar archivos de texto e imágenes
  const textMentions: typeof mentions = [];
  const imageMentions: typeof mentions = [];
  for (const m of mentions) {
    if (isImageFile(m.absPath)) {
      imageMentions.push(m);
    } else {
      textMentions.push(m);
    }
  }

  // Procesar imágenes (base64)
  const images: ImageMessage[] = [];
  for (const m of imageMentions) {
    try {
      const buf = readFileSync(m.absPath);
      if (buf.length > MAX_IMAGE_BYTES) {
        logger.warn("File mention: imagen demasiado grande", {
          path: m.path,
          size: buf.length,
        });
        continue;
      }
      const mediaType = getImageMediaType(m.absPath);
      images.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: buf.toString("base64"),
        },
      });
    } catch (err) {
      logger.warn("File mention: error al leer imagen", {
        path: m.path,
        error: String(err),
      });
    }
  }

  // Leer archivos de texto y construir el bloque de contexto
  const parts: string[] = [];
  let totalSize = 0;

  for (const m of textMentions) {
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

  if (parts.length === 0 && images.length === 0) {
    return { text: input, expandedFiles: [], images: [] };
  }

  const numMentions = mentions.length;
  const expandedFiles = mentions.map((m) => relative(process.cwd(), m.absPath) || basename(m.absPath));

  if (parts.length === 0) {
    return { text: input, expandedFiles, images };
  }

  const injectedBlock = parts.join("");
  return {
    text: `${input}\n\n[Archivos referenciados con @:]${injectedBlock}`,
    expandedFiles,
    images,
  };
}