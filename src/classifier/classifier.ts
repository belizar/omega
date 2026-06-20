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

  constructor(
    overrides: OverrideManager,
    apiKey: string,
    model = "anthropic/claude-haiku-4-5",
    baseUrl = "https://openrouter.ai/api/v1",
  ) {
    this.#overrides = overrides;
    this.#apiKey = apiKey;
    this.#model = model;
    this.#baseUrl = baseUrl;
  }

  /** Acceso al manager para operaciones externas (ej: comandos slash). */
  get overrides(): OverrideManager {
    return this.#overrides;
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

    const systemPrompt = `Eres un clasificador de seguridad para comandos bash. Evalúa el comando y responde EXACTAMENTE en este formato:

SAFE
<razón breve en una línea>

o

DANGEROUS
<razón breve en una línea>

SAFE significa: el comando es solo lectura, no modifica el filesystem, no accede a archivos sensibles, no usa red, no ejecuta código descargado, y no puede causar daño.

DANGEROUS significa: el comando modifica archivos, instala dependencias, accede a archivos sensibles (.env, ~/.ssh, /etc), usa red, ejecuta código externo, hace push/pull de git, cambia configuración del sistema, o cualquier operación con efectos secundarios permanentes.

Reglas específicas:
- npm test, npm run build, npm run dev, tsc --noEmit, vitest → SAFE (son solo build/test, no instalan ni publican)
- npm install, npm add, npm update, npm publish → DANGEROUS
- git status, git diff, git log, git branch, git stash list → SAFE
- git add, git commit, git push, git pull, git merge, git rebase, git stash → DANGEROUS
- rm, mv, cp hacia afuera del proyecto, chmod, chown → DANGEROUS
- curl, wget, piping a bash → DANGEROUS
- echo, cat, head, tail, grep, find, ls, pwd, date, wc, sort, uniq, which, type, dirname, basename, true, false → SAFE
- mkdir → DANGEROUS (crea directorios)
- node -e, node -p → evaluar el código: si es solo computación sin fs/network, SAFE; si usa require, fs, child_process, http → DANGEROUS

Responde solo con el formato indicado. Nada más.`;

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
        signal: AbortSignal.timeout(5000),
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

      return { verdict, reason: reasonLine, source: "classifier" };
    } catch (err: unknown) {
      // Si falla el clasificador, pecamos de seguros: todo DANGEROUS
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Classifier: LLM call failed, defaulting to DANGEROUS", { command, error: msg });
      return {
        verdict: "dangerous",
        reason: `Error del clasificador: ${msg}. Asumiendo DANGEROUS.`,
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
