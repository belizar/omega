import { existsSync, readFileSync, statSync, readdirSync } from "fs";
import { glob } from "fs/promises";
import { resolve, relative, basename, join } from "path";
import { isEnvFile } from "./tools/env-guard.js";
import { ImageMessage } from "./message.js";
import { logger } from "./logger.js";

const MAX_FILE_SIZE = 100_000; // ~100KB, para no volar el contexto
const MAX_TOTAL_INJECTED = 200_000; // máximo total entre todos los @files
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB máximo por imagen
const MAX_DIR_FILES = 30; // máximo de archivos a inyectar de un directorio
const MAX_DIR_FILE_BYTES = 5_000; // máximo por archivo individual dentro de un dir
const MAX_TREE_ENTRIES = 200; // máximo de entradas en el árbol

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

function isGlobPattern(s: string): boolean {
  return /[\*\?\[\]]/.test(s);
}

/** Expande un patrón glob (ej: src/**&#x2F;*.ts) a paths concretos. */
async function expandGlobMentions(
  rawPath: string,
  raw: string,
): Promise<Array<{ raw: string; path: string; absPath: string }>> {
  const results: Array<{ raw: string; path: string; absPath: string }> = [];
  try {
    for await (const entry of glob(rawPath)) {
      const abs = resolve(entry.toString());
      // Skip directories and env files
      if (isEnvFile(abs)) continue;
      try {
        if (statSync(abs).isDirectory()) continue;
      } catch {
        continue;
      }
      results.push({ raw, path: entry.toString(), absPath: abs });
    }
  } catch (err) {
    logger.warn("File mention: error expandiendo glob", {
      path: rawPath,
      error: String(err),
    });
  }
  return results;
}

/** Expande un directorio: genera un árbol y lee los archivos de texto. */
function expandDirectory(
  absPath: string,
): { textParts: string[]; files: string[] } {
  const dirName = relative(process.cwd(), absPath) || basename(absPath);
  const header = `\n--- 📁 ${dirName}/ ---\n`;
  const textParts: string[] = [header];
  const files: string[] = [];

  try {
    const entries = readdirSync(absPath, {
      recursive: true,
      withFileTypes: true,
    });

    // ── Árbol ──
    const treeLines: string[] = [];
    let treeCount = 0;

    for (const entry of entries) {
      if (treeCount >= MAX_TREE_ENTRIES) {
        treeLines.push("... (árbol truncado)");
        break;
      }

      const entryFullPath = join(entry.parentPath ?? absPath, entry.name);
      const entryRel = relative(absPath, entryFullPath);
      const depth = entryRel.split("/").length;
      const indent = "  ".repeat(depth);

      if (entry.isDirectory()) {
        treeLines.push(`${indent}📁 ${entry.name}/`);
      } else if (entry.isFile() && !isEnvFile(entry.name)) {
        treeLines.push(`${indent}📄 ${entry.name}`);
      }
      treeCount++;
    }

    textParts.push(treeLines.join("\n"));

    // ── Contenido de archivos ──
    let fileCount = 0;
    for (const entry of entries) {
      if (fileCount >= MAX_DIR_FILES) {
        textParts.push(
          `\n... (${entries.filter((e) => e.isFile()).length - MAX_DIR_FILES} archivos omitidos del directorio)`,
        );
        break;
      }
      if (!entry.isFile() || isEnvFile(entry.name)) continue;

      const fileAbs = join(entry.parentPath ?? absPath, entry.name);
      const fileRel = relative(process.cwd(), fileAbs) || basename(fileAbs);

      try {
        let content = readFileSync(fileAbs, "utf-8");
        if (content.length > MAX_DIR_FILE_BYTES) {
          content =
            content.slice(0, MAX_DIR_FILE_BYTES) +
            `\n... (truncado, ${content.length} bytes totales)`;
        }
        textParts.push(
          `\n--- ${fileRel} ---\n${content}\n--- EOF ${fileRel} ---`,
        );
        files.push(fileRel);
        fileCount++;
      } catch {
        // archivo ilegible → lo salteamos
      }
    }
  } catch (err) {
    logger.warn("File mention: error expandiendo directorio", {
      path: dirName,
      error: String(err),
    });
  }

  return { textParts, files };
}

/**
 * Detecta y expande menciones @file en el mensaje del usuario.
 * Soporta archivos, imágenes, directorios y patrones glob.
 */
export async function expandFileMentions(input: string): Promise<MentionResult> {
  // Regex: @ seguido de un path (con slash, extensión, glob char o dir explícito)
  const mentionRegex =
    /@([^\s"'`()[\]{};,!?]*(?:\/|\.|\*|\?|\[)[^\s"'`()[\]{};,!?]*)/g;

  const rawMentions: Array<{ raw: string; rawPath: string }> = [];
  const seen = new Set<string>();

  let match;
  while ((match = mentionRegex.exec(input)) !== null) {
    const rawPath = match[1];
    if (seen.has(rawPath)) continue;
    seen.add(rawPath);
    rawMentions.push({ raw: match[0], rawPath });
  }

  if (rawMentions.length === 0)
    return { text: input, expandedFiles: [], images: [] };

  // ── Resolver globs → paths concretos ──
  const mentions: Array<{ raw: string; path: string; absPath: string }> = [];
  for (const m of rawMentions) {
    if (isGlobPattern(m.rawPath)) {
      const expanded = await expandGlobMentions(m.rawPath, m.raw);
      mentions.push(...expanded);
    } else {
      mentions.push({
        raw: m.raw,
        path: m.rawPath,
        absPath: resolve(m.rawPath),
      });
    }
  }

  // ── Segunda pasada: clasificar archivos, imágenes y directorios ──
  const fileMentions: typeof mentions = [];
  const imageMentions: typeof mentions = [];
  const dirMentions: typeof mentions = [];

  for (const m of mentions) {
    if (!existsSync(m.absPath)) {
      logger.warn("File mention: path no encontrado", { path: m.path });
      continue;
    }

    let stat;
    try {
      stat = statSync(m.absPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (isEnvFile(m.absPath)) {
        logger.warn("File mention: directorio .env bloqueado", {
          path: m.path,
        });
        continue;
      }
      dirMentions.push(m);
    } else if (stat.isFile()) {
      if (isEnvFile(m.absPath)) {
        logger.warn("File mention: archivo .env bloqueado", { path: m.path });
        continue;
      }
      if (isImageFile(m.absPath)) {
        imageMentions.push(m);
      } else {
        fileMentions.push(m);
      }
    }
  }

  // ── Procesar imágenes (base64) ──
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

  // ── Procesar directorios ──
  const allParts: string[] = [];
  const allExpandedFiles: string[] = [];
  let totalSize = 0;

  for (const m of dirMentions) {
    const { textParts, files } = expandDirectory(m.absPath);
    const block = textParts.join("");
    totalSize += block.length;
    if (totalSize > MAX_TOTAL_INJECTED) break;
    allParts.push(block);
    for (const f of files) allExpandedFiles.push(f);
  }

  // ── Procesar archivos de texto ──
  for (const m of fileMentions) {
    try {
      const content = readFileSync(m.absPath, "utf-8");
      const relPath = relative(process.cwd(), m.absPath) || basename(m.absPath);
      const fileHeader = `\n--- ${relPath} ---\n`;
      const fileFooter = `\n--- EOF ${relPath} ---\n`;

      let snippet = content;
      if (snippet.length > MAX_FILE_SIZE) {
        snippet = snippet.slice(0, MAX_FILE_SIZE);
        const truncatedNote = `\n... (archivo truncado, ${content.length} bytes totales, mostrando primeros ${MAX_FILE_SIZE})`;
        totalSize +=
          fileHeader.length +
          MAX_FILE_SIZE +
          truncatedNote.length +
          fileFooter.length;
        if (totalSize > MAX_TOTAL_INJECTED) break;
        allParts.push(fileHeader + snippet + truncatedNote + fileFooter);
      } else {
        totalSize += fileHeader.length + content.length + fileFooter.length;
        if (totalSize > MAX_TOTAL_INJECTED) break;
        allParts.push(fileHeader + snippet + fileFooter);
      }
      allExpandedFiles.push(relPath);
    } catch (err) {
      logger.warn("File mention: error al leer archivo", {
        path: m.path,
        error: String(err),
      });
    }
  }

  if (allParts.length === 0 && images.length === 0) {
    return { text: input, expandedFiles: allExpandedFiles, images: [] };
  }

  if (allParts.length === 0) {
    return { text: input, expandedFiles: allExpandedFiles, images };
  }

  const injectedBlock = allParts.join("");
  return {
    text: `${input}\n\n[Archivos referenciados con @:]${injectedBlock}`,
    expandedFiles: allExpandedFiles,
    images,
  };
}