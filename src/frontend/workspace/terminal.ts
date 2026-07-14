import pty from "node-pty";
import type { IPty } from "node-pty";

/** Cuánto scrollback guardamos para el replay al reconectar (como el `history`
 *  del chat: al enganchar un cliente nuevo le mandamos esto y ve dónde quedó). */
const SCROLLBACK_CAP = 200_000;

/**
 * Un PTY vivo en el cwd de un workspace. Es "el bash del agente pero interactivo
 * y manejado por vos": raw mode, cursor addressing, resize — lo que un neovim o
 * un deploy necesitan y los pipes de `child_process` no dan.
 *
 * No sabe NADA de HTTP/WS: expone data/onData/write/resize/kill y un buffer de
 * scrollback para el replay. El puente con el transporte lo arma el daemon. Es la
 * pieza workspace-side, hermana de diff/files/review — pero stateful y viva.
 *
 * Ciclo de vida: persistente (tipo tmux). Sobrevive a que cierres el browser; se
 * mata en detach/shutdown de la sesión (lo maneja el TerminalManager).
 */
export class TerminalSession {
  #pty: IPty;
  #buffer = "";
  #dataListeners = new Set<(data: string) => void>();
  #exitListeners = new Set<() => void>();
  #alive = true;

  constructor(opts: { cwd: string; cols?: number; rows?: number; shell?: string; env?: Record<string, string> }) {
    const shell =
      opts.shell ?? process.env.SHELL ?? (process.platform === "win32" ? "powershell.exe" : "/bin/bash");

    // env limpio: node-pty quiere Record<string,string>; process.env trae undefined.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, opts.env);
    // TERM sano para que xterm.js pinte colores/estilos.
    env.TERM = env.TERM || "xterm-256color";

    this.#pty = pty.spawn(shell, [], {
      name: "xterm-color",
      cwd: opts.cwd,
      env,
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
    });

    this.#pty.onData((d) => {
      this.#append(d);
      for (const l of this.#dataListeners) l(d);
    });
    this.#pty.onExit(() => {
      this.#alive = false;
      for (const l of this.#exitListeners) l();
    });
  }

  /** Acumula en el ring buffer, capado por la cola (lo viejo se cae). */
  #append(d: string): void {
    this.#buffer += d;
    if (this.#buffer.length > SCROLLBACK_CAP) this.#buffer = this.#buffer.slice(-SCROLLBACK_CAP);
  }

  get alive(): boolean {
    return this.#alive;
  }

  /** El scrollback para pintarle a un cliente que (re)conecta. */
  get replay(): string {
    return this.#buffer;
  }

  /** Suscribe al output del PTY. Devuelve la baja. */
  onData(cb: (data: string) => void): () => void {
    this.#dataListeners.add(cb);
    return () => this.#dataListeners.delete(cb);
  }

  /** Se dispara cuando el shell termina (exit/kill). Devuelve la baja. */
  onExit(cb: () => void): () => void {
    this.#exitListeners.add(cb);
    return () => this.#exitListeners.delete(cb);
  }

  /** Teclas del cliente → PTY. */
  write(data: string): void {
    if (this.#alive) this.#pty.write(data);
  }

  /** El cliente redimensionó su terminal → ajustamos el PTY (para el reflow). */
  resize(cols: number, rows: number): void {
    if (!this.#alive) return;
    try {
      this.#pty.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
    } catch {
      /* cols/rows inválidos en una carrera de cierre: no rompemos */
    }
  }

  kill(): void {
    if (!this.#alive) return;
    this.#alive = false;
    try {
      this.#pty.kill();
    } catch {
      /* ya muerto */
    }
  }
}
