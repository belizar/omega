import { exec, execSync } from "child_process";
import { logger } from "./logger.js";

/**
 * Un contenedor Docker persistente = el "workspace" del agente (à la Gitpod /
 * Codespaces). Se arranca una vez por sesión con el workdir montado en
 * /workspace, y cada comando bash entra con `docker exec`. Persiste el
 * **filesystem** entre comandos (deps instaladas con npm/pip, archivos,
 * artefactos de build) y no se paga el startup de un contenedor por comando. (El
 * estado de shell —env vars, `cd`— NO persiste: cada exec es un `sh` nuevo, igual
 * que en CI.)
 *
 * Confinado: adentro solo se ve /workspace (el resto es el filesystem de la
 * imagen). Es el ladrillo del "checkout sandboxeado por run" de la nube.
 *
 * Ciclo de vida: `ensureStarted()` (lazy, en el primer bash) → `wrap()` por
 * comando → `stop()` al salir. Keep-alive `sleep` con tope, y label, para que un
 * omega que muere sin limpiar (ej. SIGKILL) no deje huérfanos para siempre.
 */
export class Sandbox {
  #image: string;
  #workdir: string;
  #name: string;
  #started = false;
  /** Tope de vida del contenedor (segundos). Red de seguridad anti-huérfanos. */
  #keepAliveSec = 3600;

  constructor(opts: { image: string; sessionId: string; workdir?: string }) {
    this.#image = opts.image;
    this.#workdir = opts.workdir ?? process.cwd();
    this.#name = `omega-sandbox-${opts.sessionId}`;
  }

  /** Arranca el contenedor si no está. Lazy: solo cuando el agente usa bash. */
  async ensureStarted(): Promise<void> {
    if (this.#started) return;
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    // Por las dudas, borrar un contenedor viejo con el mismo nombre (restart).
    try {
      execSync(`docker rm -f ${this.#name}`, { stdio: "ignore" });
    } catch {
      /* no existía */
    }
    const cmd =
      `docker run -d --rm --name ${this.#name} --label omega-sandbox ` +
      `--user ${uid}:${gid} -v ${JSON.stringify(this.#workdir)}:/workspace ` +
      `-w /workspace ${this.#image} sleep ${this.#keepAliveSec}`;
    await new Promise<void>((resolve, reject) => {
      exec(cmd, (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`No se pudo arrancar el sandbox: ${stderr || error.message}`));
        } else {
          resolve();
        }
      });
    });
    this.#started = true;
    logger.info("Sandbox iniciado", { container: this.#name, image: this.#image });
  }

  /** El comando (string para el host-shell) que ejecuta `command` DENTRO del
   *  contenedor. BashTool lo pasa a su mismo `exec` (con su timeout/abort). */
  wrap(command: string): string {
    const quoted = `'${command.replace(/'/g, `'\\''`)}'`;
    return `docker exec ${this.#name} sh -c ${quoted}`;
  }

  /** Mata el contenedor. Sync a propósito: se llama desde process.on("exit"). */
  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    try {
      execSync(`docker rm -f ${this.#name}`, { stdio: "ignore" });
      logger.info("Sandbox detenido", { container: this.#name });
    } catch {
      /* ya no estaba */
    }
  }
}
