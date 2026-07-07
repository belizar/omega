import { exec } from "child_process";
import { Tool } from "./tool.js";
import { logger } from "../logger.js";
import { CommandClassifier } from "../classifier/classifier.js";
import { Sandbox } from "../sandbox.js";

type BashInput = {
  command: string;
  /** Si es true, saltea el clasificador y ejecuta el comando directamente.
   * Usar solo después de que el usuario confirmó vía ask_user. */
  force?: boolean;
  /** Timeout de ESTE comando en SEGUNDOS. Pisá el default cuando sepas que va
   *  a tardar (builds, tests, installs). Sin valor → default del harness. */
  timeout?: number;
};

export type BashToolOptions = {
  classifier?: CommandClassifier;
  /** Timeout por defecto (ms) cuando el comando no especifica `timeout`. */
  defaultTimeoutMs?: number;
  /** Sandbox opcional: el "workspace" persistente donde corre el bash del agente
   *  (contenedor Docker). undefined = corre en el host (flujo local). */
  sandbox?: Sandbox;
};

const DEFAULT_TIMEOUT_MS = 120_000; // fallback si el constructor no pasa uno
const MAX_TIMEOUT_MS = 30 * 60_000; // tope duro: 30 min, evita colgar el agente
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB de stdout/stderr

// Guardarraíl determinista: patrones que nunca se ejecutan sin importar
// lo que diga el clasificador. Son el safety net para casos donde el LLM
// falle (ej: no detecte un fork bomb o un dd a un disco).
const HARDBLOCK_PATTERNS = [
  /\brm\s+-[a-z]*[rf]/i,              // rm con -r o -f
  /:\s*\(\s*\)\s*\{.*:.*\|.*:.*\}/,    // fork bomb
  />\s*\/dev\/(sd|nvme|disk|hd)/i,     // escritura directa a un disco
  /\bmkfs\b/i,                         // formatear filesystem
  /\bdd\b.*\bof=\/dev\//i,             // dd hacia un device
  /\b(shutdown|reboot|halt|poweroff)\b/i, // apagar/reiniciar la máquina
];

// Whitelist determinista: comandos inofensivos que skipean el clasificador.
// Solo se incluyen operaciones de solo-lectura o no destructivas que se usan
// constantemente en desarrollo. El guardarraíl HARDBLOCK sigue activo siempre.
const SAFE_PATTERNS = [
  // Exploración / info
  /^ls\b/, /^cat\s/, /^find\s/, /^pwd\b/, /^which\s/, /^type\s/, /^file\s/,
  /^stat\s/, /^du\s/, /^df\b/, /^realpath\s/, /^readlink\s/, /^dirname\s/,
  /^basename\s/,
  // Procesamiento de texto (solo-lectura)
  /^grep\s/, /^head\s/, /^tail\s/, /^sort\s/, /^wc\s/, /^echo\s/,
  /^cut\s/, /^awk\s/, /^uniq\s/, /^comm\s/, /^diff\s/, /^tr\s/,
  /^sed\s+(?!.*-i)/,  // sed sin -i (in-place)
  // Utilidades
  /^date\b/, /^seq\s/, /^printf\s/, /^true\b/, /^false\b/, /^sleep\s/,
  /^env\b/, /^printenv\b/,
  // Git (solo-lectura o no destructivo)
  /^git\s+status\b/, /^git\s+log\b/, /^git\s+diff\b/, /^git\s+stash\b/,
  /^git\s+branch\b/, /^git\s+remote\b/, /^git\s+show\b/, /^git\s+blame\b/,
  /^git\s+tag\b/, /^git\s+ls-/, /^git\s+rev-/, /^git\s+reflog\b/,
  /^git\s+config\s+--get\b/,
  // npm/node (package management normal, no destructivo del sistema)
  /^npm\s+(run|test|exec|ls|list|view|info|outdated|audit|find-dupes)\b/,
  /^npm\s+install\b/, /^npm\s+ci\b/, /^npm\s+update\b/,
  /^npx\s/, /^tsc\s/, /^vitest\s/,
  /^node\s+(--version|--help|-e|-v)\b/,
  // Operaciones de filesystem seguras (dentro del proyecto)
  /^mkdir\s/, /^touch\s/, /^cp\s/, /^mv\s/, /^cd\s/, /^exit\b/,
  // Archivos comprimidos (solo-lectura)
  /^tar\s+(-t|--list)/, /^unzip\s+(-l|--list)/, /^zipinfo\s/,
  // Lenguajes (solo-lectura)
  /^pip\s+(list|show|freeze|check)\b/,
  /^python\s+(--version|-c)\b/,
  // gh CLI (solo-lectura)
  /^gh\s+issue\s+(list|view|status)\b/,
  /^gh\s+pr\s+(list|view|status|checks|diff)\b/,
  /^gh\s+repo\s+(view|list)\b/,
  /^gh\s+auth\s+status\b/,
  /^gh\s+run\s+(list|view|watch)\b/,
  /^gh\s+search\s/,
  /^gh\s+api\s+(get|GET)\b/,
  /^gh\b\s*$/,
  // Hashes / checksums
  /^shasum\b/, /^sha256sum\b/, /^md5sum\b/, /^cksum\b/,
];

export class BashTool extends Tool<BashInput, string> {
  #classifier?: CommandClassifier;
  #defaultTimeoutMs: number;
  #sandbox?: Sandbox;

  constructor(options?: BashToolOptions) {
    super({
      name: "bash",
      description: "Ejecuta un comando bash y devuelve stdout y stderr",
      schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "El comando bash a ejecutar",
          },
          timeout: {
            type: "number",
            description:
              "Opcional. Timeout de este comando en SEGUNDOS. Subilo cuando " +
              "sepas que va a tardar (builds, test suites, npm install): ej. 600 " +
              "para 10 min. Sin valor usa el default del harness (120s). El " +
              "máximo es 1800 (30 min).",
          },
          force: {
            type: "boolean",
            description:
              "Opcional. Si es true, saltea el clasificador de seguridad y ejecuta " +
              "el comando directamente. Solo debe usarse después de que el usuario " +
              "haya confirmado explícitamente vía ask_user que quiere ejecutar un " +
              "comando que fue clasificado como peligroso.",
          },
        },
        required: ["command"],
      },
    });
    this.#classifier = options?.classifier;
    this.#defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#sandbox = options?.sandbox;
  }

  /**
   * El comando a correr en el host-shell. Sin sandbox, es el comando tal cual (en
   * el host). Con sandbox, es un `docker exec` al contenedor persistente del
   * agente (el workspace) → confinado a /workspace, con estado que persiste entre
   * comandos. El contenedor tiene que estar arrancado antes (ver ensureSandbox).
   */
  #wrapCommand(command: string): string {
    return this.#sandbox ? this.#sandbox.wrap(command) : command;
  }

  async execute(
    { command, force, timeout }: BashInput,
    signal?: AbortSignal,
  ): Promise<string> {
    // Timeout efectivo: override por llamada (segundos) → default del harness,
    // clampeado al tope duro. Se calcula acá afuera para que el catch lo vea.
    const requestedMs =
      typeof timeout === "number" && timeout > 0
        ? Math.round(timeout * 1000)
        : this.#defaultTimeoutMs;
    const timeoutMs = Math.min(requestedMs, MAX_TIMEOUT_MS);

    try {
      if (!command || typeof command !== "string") {
        logger.error("Invalid bash command input", { command });
        return "Error: command must be a non-empty string";
      }

      // ── Guardarraíl determinista ──────────────────────────
      // Bloquea comandos catastróficos incluso si el clasificador
      // los marca como SAFE por error. force: true lo saltea
      // (el usuario ya confirmó explícitamente vía ask_user).
      if (!force && this.isHardblocked(command)) {
        logger.warn("Hardblocked command", { command });
        return [
          "BLOQUEADO POR GUARDARRAÍL DETERMINISTA",
          "",
          `Comando: ${command}`,
          "",
          "Razón: El comando matchea patrones de bloqueo duro",
          "(rm -rf, fork bomb, escritura a discos, etc).",
          "Estos patrones son un safety net adicional al clasificador.",
          "",
          "INSTRUCCIONES PARA EL AGENTE:",
          "- No intentes este comando con otra sintaxis o herramienta.",
          "- Informale al usuario que el guardarraíl lo bloqueó.",
          "- Si el usuario insiste, que lo ejecute manualmente.",
        ].join("\n");
      }

      // ── Clasificación ──────────────────────────────────────────
      // Si el comando es claramente inofensivo (whitelist), skipea el
      // clasificador para reducir latencia y falsos positivos.
      const needsClassifier = this.#classifier && !force && !this.isSafe(command);

      if (needsClassifier) {
        const classification = await this.#classifier!.classify(command);

        if (classification.verdict === "dangerous") {
          const sourceTag = classification.source === "override"
            ? `override: "${classification.override?.pattern}"`
            : "clasificador Haiku";

          return [
            `BLOQUEADO POR CLASIFICADOR DE SEGURIDAD (${sourceTag})`,
            ``,
            `Comando: ${command}`,
            ``,
            `Razón: ${classification.reason}`,
            ``,
            `INSTRUCCIONES PARA EL AGENTE:`,
            `- No intentes este comando con otra sintaxis o herramienta.`,
            `- Informale al usuario qué comando fue bloqueado y por qué.`,
            `- Si el usuario quiere ejecutarlo igual, usá ask_user para`,
            `  preguntarle explícitamente, y si confirma, volvé a llamar`,
            `  a bash con el mismo comando y el parámetro force: true.`,
          ].join("\n");
        }
      }

      // Si force: true y el aprendizaje está habilitado, registramos el override
      if (this.#classifier && force && this.#classifier.learnEnabled) {
        this.#classifier.learnOverride(command, "safe");
      }

      // Ya interrumpido antes de arrancar: no lanzamos el proceso.
      if (signal?.aborted) {
        return "⏹ Comando cancelado antes de ejecutar (interrumpido por el usuario).";
      }

      // Sandbox: arrancar el contenedor (lazy, la primera vez) antes de ejecutar.
      if (this.#sandbox) {
        try {
          await this.#sandbox.ensureStarted();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("No se pudo arrancar el sandbox", msg);
          return `Error: no se pudo arrancar el sandbox (¿Docker corriendo?): ${msg}`;
        }
      }

      logger.info("Executing bash command", { command, force, timeoutMs });
      let aborted = false;
      const result = await new Promise<string>((resolve, reject) => {
        let closed = false;
        // onAbort se define después de tener `child`, pero el callback de exec
        // lo referencia para removerse; por eso lo declaramos acá.
        let onAbort = () => {};

        const child = exec(this.#wrapCommand(command), {
          encoding: "buffer" as BufferEncoding,
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER,
        }, (error, stdout, stderr) => {
          closed = true;
          signal?.removeEventListener("abort", onAbort);

          // juntar stdout y stderr
          const out = Buffer.isBuffer(stdout) ? stdout.toString("utf-8") : String(stdout);
          const err = Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr);
          const combined = (out + (err ? err : "")).trim();

          // Interrumpido por el usuario: devolvemos lo que alcanzó a producir,
          // sin tratarlo como error (el SIGTERM lo mandamos nosotros).
          if (aborted) {
            resolve(
              "⏹ Comando interrumpido por el usuario." +
              (combined ? `\n\nOutput parcial:\n${combined}` : ""),
            );
            return;
          }

          if (error && !combined) {
            reject(error);
          } else {
            resolve(combined || (error?.message ?? ""));
          }
        });

        // Ctrl+C del usuario → matamos el proceso hijo. SIGTERM primero, y si
        // no muere en 2s, SIGKILL. El timer se unref-ea para no atar el loop.
        onAbort = () => {
          aborted = true;
          child.kill("SIGTERM");
          const t = setTimeout(() => {
            if (!closed) child.kill("SIGKILL");
          }, 2000);
          t.unref();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      logger.info("Command executed successfully");
      return result;
    } catch (err: unknown) {
      const error = err as { code?: string; signal?: string; stderr?: string; stdout?: string; message?: string };
      if (error.code === "ETIMEDOUT" || error.signal === "SIGTERM") {
        const secs = Math.round(timeoutMs / 1000);
        const msg =
          `Error: el comando superó el timeout de ${secs}s y fue terminado. ` +
          `Si esperabas que tardara más, reintentá con un timeout mayor ` +
          `(ej: timeout: ${secs * 4}).`;
        logger.warn("Bash command timed out", { command, timeoutMs });
        return msg;
      }
      const errorMsg = error.stderr || error.stdout || error.message || String(err);
      logger.error("Bash command failed", { command, error: errorMsg });
      return errorMsg;
    }
  }

  /** Determine si el comando es claramente inofensivo y puede skipear el clasificador. */
  private isSafe(command: string): boolean {
    return SAFE_PATTERNS.some((p) => p.test(command));
  }

  private isHardblocked(command: string): boolean {
    return HARDBLOCK_PATTERNS.some((p) => p.test(command));
  }
}
