import { existsSync, readdirSync, statSync } from "fs";
import { resolve, dirname, basename, sep } from "path";
import { isEnvFile } from "../tools/env-guard.js";

/**
 * Dado un buffer y la posicion del cursor, busca el @path parcial
 * bajo el cursor y devuelve los matches del filesystem.
 *
 * Retorna { prefix, partial, matches } o null si no hay @path activo.
 *
 * - prefix: la parte ya resuelta del path (antes de partial)
 * - partial: lo que el usuario empezo a tipear despues de @
 * - matches: archivos/directorios que coinciden
 */
export function findAtPathCompletion(
  buffer: string,
  cursorPos: number,
): { prefix: string; partial: string; matches: string[] } | null {
  // Buscar @ hacia atras desde el cursor
  const atIdx = findAtSign(buffer, cursorPos);
  if (atIdx === -1) return null;

  // Extraer el path parcial: desde @+1 hasta el cursor
  const rawPartial = buffer.slice(atIdx + 1, cursorPos);

  // Si el path parcial tiene espacios o caracteres raros, no completar
  if (/[\s"'`()[\]{};,!?]/.test(rawPartial)) return null;

  const cwd = process.cwd();
  const absPartial = resolve(cwd, rawPartial);

  // Si el rawPartial termina con /, completamos DENTRO de ese directorio
  const trailingSlash = rawPartial.endsWith("/") || rawPartial.endsWith("\\");

  let dir: string;
  let partialName: string;
  let prefix: string;

  if (trailingSlash) {
    // Listar el contenido del directorio indicado
    dir = absPartial;
    partialName = "";
    // prefix es el rawPartial entero (ya incluye el /)
    prefix = rawPartial;
  } else {
    dir = dirname(absPartial);
    partialName = basename(absPartial);
    const rawDir = dirname(rawPartial);
    prefix = rawDir === "." ? "" : rawDir + sep;
  }

  // Si el directorio a buscar no existe, no hay nada que completar
  if (!existsSync(dir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  // Filtrar entries que empiezan con partialName
  const lcPartial = partialName.toLowerCase();
  const matches = entries.filter((e) => {
    if (!e.toLowerCase().startsWith(lcPartial)) return false;
    // Filtrar .env
    const fullPath = resolve(dir, e);
    if (isEnvFile(fullPath)) return false;
    return true;
  });

  if (matches.length === 0) return null;

  return {
    prefix,
    partial: partialName,
    matches: matches.sort((a, b) => {
      // Directorios primero, luego archivos, luego alfabetico
      const aIsDir =
        statSync(resolve(dir, a), { throwIfNoEntry: false })?.isDirectory() ??
        false;
      const bIsDir =
        statSync(resolve(dir, b), { throwIfNoEntry: false })?.isDirectory() ??
        false;
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    }),
  };
}

/**
 * Busca el @ mas cercano a la izquierda del cursor que no este dentro
 * de un token no completable (como un email).
 */
function findAtSign(buffer: string, cursor: number): number {
  for (let i = cursor - 1; i >= 0; i--) {
    if (buffer[i] === "@") {
      // Verificar que no sea parte de un email: el char anterior no puede ser alfanumerico
      if (i > 0 && /[a-zA-Z0-9]/.test(buffer[i - 1])) {
        // Podria ser email, seguimos buscando hacia atras
        continue;
      }
      return i;
    }
    // Si encontramos espacio, comilla, etc., paramos (el @ no esta en este token)
    if (/[\s"'`()[\]{};,!?]/.test(buffer[i])) break;
  }
  return -1;
}
