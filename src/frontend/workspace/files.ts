import { readdirSync, readFileSync, statSync } from "fs";
import { resolve, join, sep, relative } from "path";

/** Una entrada de un directorio del workspace. */
export interface FileEntry {
  name: string;
  type: "dir" | "file";
  /** Tamaño en bytes (0 para dirs). */
  size: number;
}

export interface DirListing {
  /** Path relativo al cwd (""= raíz). */
  path: string;
  entries: FileEntry[];
}

export interface FileContent {
  path: string;
  content: string;
  /** true si se cortó por tamaño. */
  truncated: boolean;
  /** true si parece binario (no se devuelve el contenido). */
  binary: boolean;
  size: number;
}

/** Dirs que se esconden por default: ruido, no código del usuario. */
const HIDDEN = new Set([".git", "node_modules", ".omega"]);

const MAX_FILE = 512 * 1024; // 512 KB: más que eso no se muestra entero

/**
 * Resuelve un path relativo CONTRA el cwd y garantiza que quede DENTRO (no
 * escapar con `../`). Es la barrera de seguridad: el cliente pide paths, y sin
 * esto un `../../etc/passwd` leería fuera del workspace. Tira si se escapa.
 */
function safeResolve(cwd: string, relPath: string): string {
  const base = resolve(cwd);
  const abs = resolve(base, relPath || ".");
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error("path fuera del workspace");
  }
  return abs;
}

/** Lista un directorio del workspace (dirs primero, luego archivos, alfabético). */
export function listDir(cwd: string, relPath = ""): DirListing {
  const abs = safeResolve(cwd, relPath);
  const entries: FileEntry[] = [];
  for (const name of readdirSync(abs)) {
    if (HIDDEN.has(name)) continue;
    let isDir = false;
    let size = 0;
    try {
      const st = statSync(join(abs, name));
      isDir = st.isDirectory();
      size = isDir ? 0 : st.size;
    } catch {
      continue; // symlink roto, permiso denegado, etc.
    }
    entries.push({ name, type: isDir ? "dir" : "file", size });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return { path: relative(resolve(cwd), abs), entries };
}

/** Devuelve el contenido de un archivo del workspace (o marca binario/truncado). */
export function readFileContent(cwd: string, relPath: string): FileContent {
  const abs = safeResolve(cwd, relPath);
  const st = statSync(abs);
  if (st.isDirectory()) throw new Error("es un directorio");
  const path = relative(resolve(cwd), abs);
  const buf = readFileSync(abs);
  // Heurística de binario: un NUL en los primeros 8KB.
  const binary = buf.subarray(0, 8192).includes(0);
  if (binary) return { path, content: "", truncated: false, binary: true, size: st.size };
  const truncated = buf.length > MAX_FILE;
  const content = buf.subarray(0, MAX_FILE).toString("utf-8");
  return { path, content, truncated, binary: false, size: st.size };
}
