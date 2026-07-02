import { execSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";

/**
 * Identidad del proyecto — fuente única para cabinet y telemetría.
 *
 * Dos caras del mismo concepto:
 *  - `resolveGitRoot` / `projectRoot`: el PATH canónico compartido (dónde vive
 *    el cabinet en disco). Worktree-aware y bare-layout-aware.
 *  - `inferProjectSlug`: el NOMBRE estable (cómo se agrupa la telemetría).
 *    Preferencia el repo remoto; cae al basename del root compartido.
 *
 * Ambos derivan de la misma resolución, así "el proyecto" es un solo concepto.
 */

/**
 * Root canónico del repo, resuelto al repo real (no al worktree).
 *
 * - Repo normal: el directorio que contiene `.git`.
 * - Worktree (normal o layout bare): sigue el puntero `gitdir` del `.git` archivo
 *   hasta el git dir común y devuelve su parent, así TODOS los worktrees
 *   comparten el mismo root.
 *
 * null si `cwd` no está dentro de un repo git.
 */
export function resolveGitRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      // Worktree: .git es un archivo que apunta al gitdir real.
      if (statSync(gitPath).isFile()) {
        try {
          const content = readFileSync(gitPath, "utf-8").trim();
          // gitdir = <gitCommonDir>/worktrees/<name>
          const match = content.match(/^gitdir:\s+(.+)$/);
          if (match) {
            // El git dir común (dirname²) es el repo real: /proj/.git en layout
            // normal, o /mf/medra-functions.git en layout bare + worktrees. El
            // root del proyecto es su parent — compartido por los worktrees.
            const commonDir = dirname(dirname(match[1]));
            const repoRoot = dirname(commonDir);
            if (existsSync(commonDir)) return repoRoot;
          }
        } catch {
          /* fallback: usar dir */
        }
      }
      // Repo normal: .git es un directorio.
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Root del proyecto (worktree-aware) o el cwd resuelto si no hay repo. */
export function projectRoot(cwd: string): string {
  return resolveGitRoot(cwd) ?? resolve(cwd);
}

// Memo: inferProjectSlug puede llamarse seguido (cada #save de telemetría);
// el remote se resuelve una sola vez por directorio en vez de spawnear git.
const slugCache = new Map<string, { slug: string; root: string }>();

/**
 * Slug estable del proyecto desde un CWD.
 *
 * Prioridad:
 *  1. Nombre del repo remoto (`git remote origin`) — estable a través de
 *     worktrees, del layout bare, y de clones.
 *  2. Basename del root compartido (mismo que usa el cabinet).
 *
 * Devuelve `{ slug, root }` donde `root` es el mismo `projectRoot` que ancla el
 * cabinet, así ambos coinciden siempre en "qué es el proyecto".
 */
export function inferProjectSlug(cwd: string): { slug: string; root: string } {
  const key = resolve(cwd);
  const cached = slugCache.get(key);
  if (cached) return cached;

  const root = projectRoot(key);
  let slug: string | null = null;

  try {
    const remote = execSync("git remote get-url origin", {
      cwd: key,
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = remote.match(/[:/]([^/]+?)(?:\.git)?$/);
    if (m) slug = m[1];
  } catch {
    // sin git o sin remote → fallback al basename del root
  }

  if (!slug) slug = basename(root);

  const result = { slug, root };
  slugCache.set(key, result);
  return result;
}
