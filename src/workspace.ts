import { execFile } from "child_process";
import { cp, mkdir, stat } from "fs/promises";
import { dirname, join } from "path";
import { promisify } from "util";
import { ResolvedWorktreeConfig } from "./config.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/**
 * El directorio de trabajo de una sesión: dónde operan sus tools (bash/read/
 * edit/...). Con multi-sesión en un solo proceso no podemos `process.chdir()`
 * (es global), así que cada sesión lleva su cwd y se lo inyecta a las tools.
 *
 * Dos modos:
 *  - **compartido** (default): todas las sesiones sobre el mismo baseDir.
 *  - **aislado**: un `git worktree` con branch propia por sesión, en una ruta
 *    visible y configurable (`worktree.dir`), con los archivos de config
 *    (`worktree.copy`: .env, settings) copiados adentro — sin eso el checkout
 *    nace inutilizable. Aislamiento local real sin contenedor.
 *
 * Un `worktree.command` en la config reemplaza el git built-in (delegación a un
 * script propio tipo tree.sh): Omega fija el path y el comando lo puebla.
 */
export interface Workspace {
  /** Directorio donde corren las tools de la sesión. */
  readonly cwd: string;
  /** true si es un worktree dedicado; false si comparte el baseDir. */
  readonly isolated: boolean;
  /** Branch del worktree (solo si isolated). */
  readonly branch?: string;
  /** Libera el workspace (remueve el worktree si aplica). Idempotente. */
  dispose(): Promise<void>;
}

/** ¿`dir` está dentro de un árbol de trabajo git? (condición para crear un worktree). */
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

async function branchExists(baseDir: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: baseDir,
    });
    return true;
  } catch {
    return false;
  }
}

/** Copia cada entrada de `copy` (relativa a baseDir) al worktree, misma ruta relativa.
 *  Silenciosa si la fuente no existe (no todos los repos tienen todos los archivos). */
async function copyConfigFiles(baseDir: string, dest: string, copy: string[]): Promise<void> {
  for (const rel of copy) {
    const from = join(baseDir, rel);
    const to = join(dest, rel);
    try {
      await stat(from);
    } catch {
      continue; // la fuente no existe; nada que copiar
    }
    try {
      await mkdir(dirname(to), { recursive: true });
      await cp(from, to, { recursive: true });
      logger.info("workspace config copiada", { rel });
    } catch (err) {
      logger.warn("no se pudo copiar config al worktree", {
        rel,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const NOOP_DISPOSE = async (): Promise<void> => {};

function shared(baseDir: string): Workspace {
  return { cwd: baseDir, isolated: false, dispose: NOOP_DISPOSE };
}

export interface CreateWorkspaceOpts {
  baseDir: string;
  sessionId: string;
  /** Si true, la sesión corre en un worktree aislado; si no, comparte baseDir. */
  isolate?: boolean;
  /** Branch del worktree (default: omega/<idcorto>). */
  branch?: string;
  /** Branch base de la que se crea (default: worktree.baseBranch, o HEAD). */
  base?: string;
  config: ResolvedWorktreeConfig;
}

/**
 * Arma el workspace de una sesión. Con `isolate` intenta un worktree con branch
 * propia; si `baseDir` no es un repo git (y no hay command), cae a compartido con
 * un warning (no revienta — "que corra en local" es el norte del MVP).
 */
export async function createWorkspace(opts: CreateWorkspaceOpts): Promise<Workspace> {
  const { baseDir, sessionId, isolate, config } = opts;

  if (!isolate) return shared(baseDir);

  const usingCommand = config.command.trim().length > 0;
  if (!usingCommand && !(await isGitWorktree(baseDir))) {
    logger.warn("sesión aislada pedida pero baseDir no es repo git; uso cwd compartido", {
      baseDir,
      sessionId,
    });
    return shared(baseDir);
  }

  const branch = (opts.branch || `omega/${sessionId.slice(0, 8)}`).trim();
  const base = (opts.base || config.baseBranch || "").trim();
  const wtPath = join(baseDir, config.dir, branch);
  await mkdir(dirname(wtPath), { recursive: true });

  if (usingCommand) {
    // Delegación: el comando puebla $OMEGA_WORKTREE_PATH. Omega fija el path.
    await runHook(config.command, baseDir, { path: wtPath, branch, base });
    logger.info("workspace creado vía command", { branch, wtPath });
  } else {
    // Built-in: branch nueva (o checkout si ya existe), NO detached → pusheable.
    if (await branchExists(baseDir, branch)) {
      await execFileAsync("git", ["worktree", "add", wtPath, branch], { cwd: baseDir });
    } else {
      const args = ["worktree", "add", "-b", branch, wtPath];
      if (base) args.push(base);
      await execFileAsync("git", args, { cwd: baseDir });
    }
    logger.info("workspace worktree creado", { branch, base: base || "HEAD", wtPath });
  }

  // Config por proyecto (.env, settings): sin esto el checkout no funciona.
  await copyConfigFiles(baseDir, wtPath, config.copy);

  return {
    cwd: wtPath,
    isolated: true,
    branch,
    dispose: makeWorktreeDispose(baseDir, wtPath, branch, base, config),
  };
}

/**
 * Re-arma el Workspace de una sesión que ya tiene su worktree en disco (revivir).
 * No crea nada: apunta a un cwd existente. Su dispose SÍ puede remover el worktree
 * (si algún día cerrás la sesión de verdad), pero revivir/detach no lo llaman.
 */
export function attachWorkspace(opts: {
  baseDir: string;
  cwd: string;
  isolated: boolean;
  branch?: string;
  config: ResolvedWorktreeConfig;
}): Workspace {
  if (!opts.isolated) {
    return { cwd: opts.cwd, isolated: false, dispose: NOOP_DISPOSE };
  }
  return {
    cwd: opts.cwd,
    isolated: true,
    branch: opts.branch,
    dispose: makeWorktreeDispose(opts.baseDir, opts.cwd, opts.branch ?? "", "", opts.config),
  };
}

/** Fabrica el dispose de un worktree (remove-command o git worktree remove). Idempotente. */
function makeWorktreeDispose(
  baseDir: string,
  wtPath: string,
  branch: string,
  base: string,
  config: ResolvedWorktreeConfig,
): () => Promise<void> {
  let disposed = false;
  return async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try {
      if (config.removeCommand.trim()) {
        await runHook(config.removeCommand, baseDir, { path: wtPath, branch, base });
      } else {
        // Removemos el worktree pero DEJAMOS la branch (por si querés PR-earla).
        await execFileAsync("git", ["worktree", "remove", "--force", wtPath], { cwd: baseDir });
      }
      logger.info("workspace worktree removido", { branch, wtPath });
    } catch (err) {
      logger.warn("no se pudo remover el worktree", {
        branch,
        wtPath,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/** Corre un hook de worktree pasándole el contrato por env vars. */
async function runHook(
  command: string,
  cwd: string,
  vars: { path: string; branch: string; base: string },
): Promise<void> {
  await execFileAsync(command, [], {
    cwd,
    shell: true,
    env: {
      ...process.env,
      OMEGA_WORKTREE_PATH: vars.path,
      OMEGA_WORKTREE_BRANCH: vars.branch,
      OMEGA_WORKTREE_BASE: vars.base,
    },
  });
}
