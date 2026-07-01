import { OverrideManager, type Override } from "./overrides.js";
import { logger } from "../logger.js";

export type Classification = "safe" | "dangerous";

export interface ClassifierResult {
  verdict: Classification;
  reason: string;
  /** Si vino de un override, no gastó tokens */
  source: "override" | "classifier";
  /** El override que matcheó, si source === "override" */
  override?: Override;
}

export type ClassifierOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Habilita el aprendizaje automático de overrides (default: false) */
  learnEnabled?: boolean;
};

/**
 * Clasifica comandos bash como SAFE o DANGEROUS.
 *
 * Pipeline:
 * 1. Chequea overrides locales (manuales y aprendidos).
 * 2. Si no matchea, llama a un LLM barato via OpenRouter.
 * 3. Devuelve el veredicto con la razón.
 */
export class CommandClassifier {
  #overrides: OverrideManager;
  #apiKey: string;
  #model: string;
  #baseUrl: string;
  #learnEnabled: boolean;
  #consecutiveFailures = 0;

  constructor(
    overrides: OverrideManager,
    options: ClassifierOptions,
  ) {
    this.#overrides = overrides;
    this.#apiKey = options.apiKey;
    this.#model = options.model || "anthropic/claude-haiku-4-5";
    this.#baseUrl = options.baseUrl || "https://openrouter.ai/api/v1";
    this.#learnEnabled = options.learnEnabled ?? false;
  }

  /** Acceso al manager para operaciones externas (ej: comandos slash). */
  get overrides(): OverrideManager {
    return this.#overrides;
  }

  /** Si el aprendizaje automático está habilitado. */
  get learnEnabled(): boolean {
    return this.#learnEnabled;
  }

  /** Modelo actual del clasificador. */
  get model(): string {
    return this.#model;
  }

  /** Cambia el modelo del clasificador (ej: override por sesión vía /model). */
  setModel(model: string): void {
    this.#model = model;
  }

  async classify(command: string): Promise<ClassifierResult> {
    // 1. Chequear overrides
    const override = this.#overrides.lookup(command);
    if (override) {
      logger.info("Classifier: override match (no LLM call)", {
        command,
        verdict: override.verdict,
        source: override.source,
        pattern: override.pattern,
      });
      return {
        verdict: override.verdict,
        reason: override.reason || `Override: ${override.pattern}`,
        source: "override",
        override,
      };
    }

    // 2. Llamar al LLM clasificador
    return this.classifyWithLLM(command);
  }

  private async classifyWithLLM(command: string): Promise<ClassifierResult> {
    const fewShot = this.#overrides.getFewShotExamples(command);

    let fewShotBlock = "";
    if (fewShot.length > 0) {
      fewShotBlock = `
Overrides del usuario (comandos previamente reclasificados):
${fewShot.map((o) => `  "${o.pattern}" → el usuario lo marcó ${o.verdict.toUpperCase()}`).join("\n")}
`;
    }

    const systemPrompt = `Eres un clasificador de seguridad para comandos bash en un entorno de DESARROLLO.
El agente trabaja en un proyecto de código y tiene que poder hacer su trabajo
normal sin fricción. Bloquea SOLO lo que cause daño IRREVERSIBLE o robe datos.

Responde EXACTAMENTE:
SAFE
<razón breve>
o
DANGEROUS
<razón breve>

DANGEROUS = solo daño irreversible o robo/ejecución de código no confiable:
- Pérdida de datos: rm -rf, borrar muchos archivos, git reset --hard,
  git push --force, git clean -fdx, dd, mkfs, sobrescribir/truncar archivos
  importantes, dropear bases de datos.
- Exfiltración: leer .env / ~/.ssh / credenciales Y mandarlas por red.
- Código no confiable: curl|bash, wget|sh, eval de contenido remoto.
- Daño al sistema: escribir en /etc, sudo, config global, matar procesos del sistema.

SAFE = TODO lo demás, incluido el flujo de desarrollo normal:
- git add/commit/push/pull/checkout/switch/branch/merge/rebase/stash/fetch
  (cualquier git que NO sea --force, reset --hard, ni clean -fdx).
- mkdir, touch, mv, cp dentro del proyecto, editar archivos.
- npm/yarn install/add/run/test/build, tsc, vitest.
- curl/wget para LEER una API o URL (no piped a shell, sin mandar secretos).
- ls, cat, grep, find, echo, pwd, etc.

Principio: modificar archivos del proyecto, usar git normalmente, instalar deps y
leer de la red NO son peligrosos — son el trabajo diario. Peligroso es lo que no
se puede deshacer, o lo que roba/ejecuta cosas.

Responde solo con el formato. Nada más.`;

    const body = JSON.stringify({
      model: this.#model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Comando: ${command}\n${fewShotBlock}` },
      ],
      max_tokens: 50,
      temperature: 0,
    });

    try {
      logger.info("Classifier: calling LLM", { command, model: this.#model });

      const resp = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }

      const json = (await resp.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      const content = json.choices?.[0]?.message?.content?.trim() || "";

      logger.info("Classifier: LLM response", {
        command,
        content,
        tokens: json.usage?.prompt_tokens,
      });

      const lines = content.split("\n").filter((l) => l.trim());
      const verdictLine = lines[0]?.trim().toLowerCase();
      const reasonLine = lines[1]?.trim() || "";

      const verdict: Classification =
        verdictLine === "safe" ? "safe" : "dangerous";

      // Clasificación exitosa → resetea el contador de fallos
      this.#consecutiveFailures = 0;

      return { verdict, reason: reasonLine, source: "classifier" };
    } catch (err: unknown) {
      // Si el clasificador falla, degradamos a SAFE después de N fallos
      // consecutivos. Mientras tanto, marcamos DANGEROUS por seguridad.
      this.#consecutiveFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      const fallbackVerdict = this.#consecutiveFailures >= 3
        ? ("safe" as Classification)
        : ("dangerous" as Classification);
      logger.warn(
        `Classifier: LLM call failed (${this.#consecutiveFailures}/3 consecutivas), defaulting to ${fallbackVerdict.toUpperCase()}`,
        { command, error: msg },
      );
      return {
        verdict: fallbackVerdict,
        reason: `Error del clasificador: ${msg}. Tras ${this.#consecutiveFailures} fallos consecutivos, asumiendo ${fallbackVerdict.toUpperCase()}.`,
        source: "classifier",
      };
    }
  }

  /**
   * Aprende del feedback: cuando el usuario confirma o rechaza un veredicto
   * del clasificador, registramos el override.
   */
  async learnOverride(command: string, verdict: "safe" | "dangerous"): Promise<void> {
    await this.#overrides.learn(command, verdict);
  }
}
