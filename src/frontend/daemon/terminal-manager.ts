import { TerminalSession } from "../workspace/terminal.js";

/** Sin clientes conectados por este tiempo → matamos el PTY (anti-huérfanos,
 *  mismo espíritu que el cleanup del Sandbox). Persistente ≠ inmortal. */
const IDLE_TIMEOUT_MS = 30 * 60_000;

/**
 * Dueño de los PTYs del daemon: un `TerminalSession` por sesión (v1: uno).
 * Persistente tipo tmux — el PTY sobrevive a que cierres el browser (reconectás y
 * seguís donde ibas), pero:
 *  - refcount de clientes: cuando el último se va, arranca un idle-timer; si nadie
 *    vuelve en IDLE_TIMEOUT_MS, se mata (no dejamos shells colgadas para siempre).
 *  - `kill`/`killAll`: en detach/shutdown de la sesión (lo llama el ServeMode).
 */
export class TerminalManager {
  #terminals = new Map<string, TerminalSession>();
  #clients = new Map<string, number>();
  #idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Get-or-create del PTY de una sesión, spawneado en su cwd. */
  getOrCreate(sessionId: string, cwd: string): TerminalSession {
    const existing = this.#terminals.get(sessionId);
    if (existing && existing.alive) return existing;

    const term = new TerminalSession({ cwd });
    // Si el shell muere solo (exit), lo sacamos del map para que el próximo
    // getOrCreate spawnee uno nuevo.
    term.onExit(() => this.#forget(sessionId));
    this.#terminals.set(sessionId, term);
    return term;
  }

  /** Un cliente (WS) se conectó: cancela cualquier idle-timer pendiente. */
  attach(sessionId: string): void {
    this.#clients.set(sessionId, (this.#clients.get(sessionId) ?? 0) + 1);
    const t = this.#idleTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.#idleTimers.delete(sessionId);
    }
  }

  /** Un cliente se fue: si era el último, arranca el idle-timer. */
  detach(sessionId: string): void {
    const n = (this.#clients.get(sessionId) ?? 1) - 1;
    if (n > 0) {
      this.#clients.set(sessionId, n);
      return;
    }
    this.#clients.delete(sessionId);
    if (!this.#terminals.has(sessionId)) return;
    const timer = setTimeout(() => this.kill(sessionId), IDLE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref(); // no mantener vivo el proceso
    this.#idleTimers.set(sessionId, timer);
  }

  /** Mata el PTY de una sesión (detach/shutdown). */
  kill(sessionId: string): void {
    this.#terminals.get(sessionId)?.kill();
    this.#forget(sessionId);
  }

  killAll(): void {
    for (const term of this.#terminals.values()) term.kill();
    for (const t of this.#idleTimers.values()) clearTimeout(t);
    this.#terminals.clear();
    this.#idleTimers.clear();
    this.#clients.clear();
  }

  #forget(sessionId: string): void {
    this.#terminals.delete(sessionId);
    this.#clients.delete(sessionId);
    const t = this.#idleTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.#idleTimers.delete(sessionId);
    }
  }
}
