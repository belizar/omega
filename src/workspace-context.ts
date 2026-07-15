import { homedir } from "os";
import { join } from "path";
import { loadMcpConfig } from "./mcp/client.js";
import { resolveGitRoot } from "./project.js";
import { loadSkills } from "./skills.js";
import { loadCustomCommands } from "./commands/custom.js";

/**
 * El contexto de UN workspace — el worktree/dir donde opera una sesión. Resuelve,
 * de forma explícita y en un solo lugar, el root del proyecto y la CONFIG EN CAPAS
 * (el `.omega/` del proyecto, con fallback al global `~/.omega/`): MCP, skills y
 * slash commands.
 *
 * Es la costura que arregla el bug de raíz del daemon multi-sesión: antes cada
 * loader usaba `process.cwd()` — el cwd de ARRANQUE del daemon (ej. ~/Workspace),
 * NO el worktree de la sesión. Con este objeto el cwd es explícito y único, no un
 * default implícito disperso por 20 loaders.
 *
 * Jerarquía (ver docs/design/omega-context-hierarchy.md):
 *   ProjectContext (1 por repo) → WorkspaceContext (N) → Session (N).
 * Hoy cada WorkspaceContext resuelve su propia config; el ProjectContext (cachear
 * la config compartida entre los N worktrees del mismo repo) es el próximo escalón.
 */
export class WorkspaceContext {
  /** El dir donde opera la sesión (el worktree). */
  readonly cwd: string;
  /** El root del repo (git-root), o el cwd si no es repo. Grano "proyecto":
   *  el `.omega/` vive acá, aunque la sesión opere en un subdir. */
  readonly projectRoot: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.projectRoot = resolveGitRoot(cwd) ?? cwd;
  }

  /** Servers MCP: `.omega/mcp.json` del proyecto, con fallback al global. */
  loadMcp() {
    return loadMcpConfig(join(this.projectRoot, ".omega")) ?? loadMcpConfig(join(homedir(), ".omega"));
  }

  /** Skills del proyecto + global (loadSkills mergea; el proyecto pisa). */
  loadSkills() {
    return loadSkills(this.projectRoot);
  }

  /** Slash commands custom del proyecto + global. */
  loadCommands() {
    return loadCustomCommands(this.projectRoot);
  }
}
