import { execFile } from "child_process";
import { mkdir } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/**
 * El directorio de trabajo de una sesión: dónde operan sus tools (bash/read/
 * edit/...). Con multi-sesión en un solo proceso no podemos `process.chdir()`
 * (es global), así que cada sesión lleva su cwd y se lo inyecta a las tools.
 *
 * Dos modos:
 *  - **compartido** (default): todas las sesiones sobre el mismo baseDir. Simple,
 *    pero dos agentes pueden pisarse editando el mismo archivo.
 *  - **aislado**: un `git worktree` detached por sesión, bajo `.omega/worktrees/`
 *    (gitignoreado → invisible al árbol del repo padre). Aislamiento real a nivel
 *    filesystem, sin contenedor. Es el primitivo local; el sandbox (#85) sería la
 *    versión OS-level para la nube.
 */
export interface Workspace {
  /** Directorio donde corren las tools de la sesión. */
  readonly cwd: string;
  /** true si es un worktree dedicado; false si comparte el baseDir. */
  readonly isolated: boolean;
  /** Libera el workspace (remueve el worktree si aplica). Idempotente. */
  dispose(): Promise<void>;
}

/** ¿`dir` está dentro de un árbol de trabajo git? (condición para poder crear un worktree). */
async function isGitWorktree(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: dir },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

const NOOP_DISPOSE = async (): Promise<void> => {};

/**
 * Arma el workspace de una sesión. Con `worktree: true` intenta un worktree
 * detached; si `baseDir` no es un repo git, cae a compartido con un warning (no
 * revienta — "que corra en local" es el norte del MVP).
 */
export async function createWorkspace(opts: {
  baseDir: string;
  sessionId: string;
  worktree?: boolean;
}): Promise<Workspace> {
  const { baseDir, sessionId, worktree } = opts;

  if (!worktree) {
    return { cwd: baseDir, isolated: false, dispose: NOOP_DISPOSE };
  }

  if (!(await isGitWorktree(baseDir))) {
    logger.warn("worktree pedido pero baseDir no es un repo git; uso cwd compartido", {
      baseDir,
      sessionId,
    });
    return { cwd: baseDir, isolated: false, dispose: NOOP_DISPOSE };
  }

  const wtRoot = join(baseDir, ".omega", "worktrees");
  const wtPath = join(wtRoot, sessionId);
  await mkdir(wtRoot, { recursive: true });
  // --detach: HEAD despegado en el commit actual. Permite N worktrees en el mismo
  // commit (git prohibiría N en la misma rama).
  await execFileAsync("git", ["worktree", "add", "--detach", wtPath], { cwd: baseDir });
  logger.info("workspace worktree creado", { sessionId, wtPath });

  let disposed = false;
  return {
    cwd: wtPath,
    isolated: true,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        await execFileAsync("git", ["worktree", "remove", "--force", wtPath], {
          cwd: baseDir,
        });
        logger.info("workspace worktree removido", { sessionId, wtPath });
      } catch (err) {
        logger.warn("no se pudo remover el worktree", {
          sessionId,
          wtPath,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
