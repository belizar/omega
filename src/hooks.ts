import { spawn } from "child_process";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { logger } from "./logger.js";

/**
 * Hooks: handlers deterministas que el usuario engancha a puntos del ciclo de
 * vida del agente (ver docs/design). Caso guía: notificar cuando el agente
 * necesita atención — igual que los hooks de Claude Code que consume cmux.
 *
 * v1: solo command hooks (shell), fire-and-forget (spawn con timeout, no se
 * espera el resultado). El contrato espeja el de Claude Code donde se puede
 * (mismo shape de JSON por stdin) → interop con tooling del ecosistema.
 */
export interface HookDef {
  /** Shell a ejecutar. */
  command: string;
  /** Opcional (solo eventos de tool): filtra por nombre de tool. */
  matcher?: string;
}

/** evento → lista de handlers. Ej: { "ask-user": [{command: "terminal-notifier …"}] }. */
export type HooksConfig = Record<string, HookDef[]>;

/** Puntos de enganche (ver diseño). Los dos de atención son `turn-end` y
 *  `ask-user`; hoy el loop dispara turn-start/turn-end/ask-user. Los tool-events
 *  (con `matcher`) están en el contrato para el roadmap. */
export type HookEvent =
  | "session-start"
  | "turn-start"
  | "turn-end"
  | "ask-user"
  | "pre-tool"
  | "post-tool"
  | "error";

export const DEFAULT_HOOKS_PATH = join(homedir(), ".omega", "hooks.json");

export class HookRunner {
  #hooks: HooksConfig;
  #timeoutMs: number;

  constructor(hooks: HooksConfig = {}, timeoutMs = 5000) {
    this.#hooks = hooks;
    this.#timeoutMs = timeoutMs;
  }

  /** Carga desde un `hooks.json` (`{ evento: [handlers] }`). Si no existe o está
   *  roto, devuelve un runner vacío (los hooks son opcionales). */
  static load(path = DEFAULT_HOOKS_PATH): HookRunner {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const hooks = raw && typeof raw === "object" && raw.hooks ? raw.hooks : raw;
      if (hooks && typeof hooks === "object") return new HookRunner(hooks as HooksConfig);
    } catch {
      /* sin hooks.json (lo normal) o JSON inválido → runner vacío */
    }
    return new HookRunner();
  }

  /** ¿Hay algún handler configurado? (para saltar el trabajo si no.) */
  get isEmpty(): boolean {
    return Object.keys(this.#hooks).length === 0;
  }

  /**
   * Dispara los handlers de un evento. Fire-and-forget: cada `command` se spawnea
   * con el JSON del payload por stdin + env vars de conveniencia, con timeout. No
   * bloquea el loop del agente ni espera el resultado.
   */
  fire(event: HookEvent, payload: Record<string, unknown>, opts?: { toolName?: string }): void {
    const handlers = this.#hooks[event];
    if (!handlers || handlers.length === 0) return;
    for (const h of handlers) {
      if (h.matcher && opts?.toolName && h.matcher !== opts.toolName) continue;
      this.#spawn(h.command, event, payload);
    }
  }

  #spawn(command: string, event: HookEvent, payload: Record<string, unknown>): void {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    env.OMEGA_EVENT = event;
    if (typeof payload.cwd === "string") env.OMEGA_CWD = payload.cwd;
    if (typeof payload.sessionId === "string") env.OMEGA_SESSION_ID = payload.sessionId;
    if (typeof payload.toolName === "string") env.OMEGA_TOOL_NAME = payload.toolName;
    if (typeof payload.path === "string") env.OMEGA_TOOL_PATH = payload.path;

    try {
      const child = spawn(command, {
        shell: true,
        stdio: ["pipe", "ignore", "ignore"],
        env,
        timeout: this.#timeoutMs,
      });
      child.on("error", (err) => logger.warn("hook falló al spawnear", { event, err: String(err) }));
      child.stdin?.on("error", () => { /* el hook cerró stdin: ignorar EPIPE */ });
      child.stdin?.end(JSON.stringify({ event, ...payload }));
    } catch (err) {
      logger.warn("hook no se pudo ejecutar", { event, command, err: String(err) });
    }
  }
}
