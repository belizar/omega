import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Un archivo cambiado, con su parche unificado (el que produce git). */
export interface DiffFile {
  path: string;
  /** Path viejo, si es un rename. */
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  /** Diff unificado de ESTE archivo (tal cual lo emite git). El cliente lo pinta. */
  patch: string;
}

export interface DiffResult {
  /** Contra qué se comparó: null = working tree vs HEAD (cambios sin commitear);
   *  un ref (ej "main") = los commits de la branch/PR desde que divergió. */
  base: string | null;
  files: DiffFile[];
  totals: { files: number; additions: number; deletions: number };
}

/** Corre git en `cwd`; devuelve stdout (o "" si el comando falla — ej. no es repo). */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    // `git diff` sale con código 1 cuando HAY diferencias (no es error). Igual
    // capturamos el stdout de esos casos (execFile lo adjunta al error).
    const out = (e as { stdout?: string })?.stdout;
    return typeof out === "string" ? out : "";
  }
}

const STATUS: Record<string, DiffFile["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
};

/**
 * Calcula el diff estructurado de un workspace. Dos modos según `base`:
 *  - sin base: cambios del working tree vs HEAD (lo que el agente tocó sin
 *    commitear) + archivos nuevos (untracked).
 *  - con base (ej "main"): los cambios de la branch/PR desde que divergió de base
 *    (`base...HEAD`) — para revisar una PR ajena.
 *
 * No parsea el diff a mano: usa el parche unificado de git per-file y lo entrega
 * al cliente, que lo pinta. Sí junta numstat (conteos) + name-status (estado).
 */
export async function computeDiff(cwd: string, base?: string): Promise<DiffResult> {
  const range = base ? [`${base}...HEAD`] : ["HEAD"];
  // Excluimos `.omega/` — es el estado propio de omega en el worktree (transcripts,
  // commands, config), NO cambios de código del agente. Si no, ahoga el diff.
  const paths = ["--", ".", ":(exclude).omega"];

  // Conteos por archivo: "adds\tdels\tpath" (o "-\t-\t" si es binario).
  const numstat = await git(cwd, ["diff", "--numstat", ...range, ...paths]);
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split("\t");
    const path = rest.join("\t");
    const binary = a === "-" && d === "-";
    counts.set(path, { additions: binary ? 0 : Number(a) || 0, deletions: binary ? 0 : Number(d) || 0, binary });
  }

  // Estado por archivo: "M\tpath" | "A\tpath" | "R100\told\tnew" | ...
  const nameStatus = await git(cwd, ["diff", "--name-status", ...range, ...paths]);
  const meta = new Map<string, { status: DiffFile["status"]; oldPath?: string }>();
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0][0];
    if (code === "R") {
      meta.set(parts[2], { status: "renamed", oldPath: parts[1] });
    } else {
      meta.set(parts[1], { status: STATUS[code] ?? "modified" });
    }
  }

  // Parche unificado completo, partido por archivo ("diff --git a/… b/…").
  const full = await git(cwd, ["diff", ...range, ...paths]);
  const patches = splitPatches(full);

  const files: DiffFile[] = [];
  for (const [path, m] of meta) {
    const c = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
    files.push({
      path,
      oldPath: m.oldPath,
      status: m.status,
      additions: c.additions,
      deletions: c.deletions,
      binary: c.binary,
      patch: patches.get(path) ?? "",
    });
  }

  // Archivos nuevos sin trackear (solo en el modo working-tree). Se ven como added.
  if (!base) {
    const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", ...paths]))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const path of untracked) {
      // `git diff --no-index /dev/null <file>` da un parche "todo agregado".
      const patch = await git(cwd, ["diff", "--no-index", "--", "/dev/null", path]);
      const additions = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
      files.push({ path, status: "added", additions, deletions: 0, binary: false, patch });
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const totals = files.reduce(
    (t, f) => ({ files: t.files + 1, additions: t.additions + f.additions, deletions: t.deletions + f.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  );
  return { base: base ?? null, files, totals };
}

/** Parte un `git diff` completo en un mapa path → parche de ese archivo. La ruta
 *  la sacamos de la línea `+++ b/<path>` (o `--- a/<path>` si fue borrado). */
function splitPatches(full: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!full.trim()) return out;
  const chunks = full.split(/(?=^diff --git )/m);
  for (const chunk of chunks) {
    if (!chunk.startsWith("diff --git")) continue;
    const plus = chunk.match(/^\+\+\+ b\/(.+)$/m);
    const minus = chunk.match(/^--- a\/(.+)$/m);
    let path = plus?.[1] ?? minus?.[1];
    if (!path || path === "/dev/null") {
      // borrado o binario sin +++: sacar del header "diff --git a/x b/x".
      const hdr = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
      path = hdr?.[2] ?? hdr?.[1];
    }
    if (path) out.set(path, chunk.trimEnd() + "\n");
  }
  return out;
}
