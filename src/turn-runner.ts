import { Context } from "./app-context.js";
import { resolveAgentModel, getProfileByName } from "./config.js";
import { CoreServices } from "./core.js";
import { Frontend } from "./frontend/frontends/frontend.js";
import { logger } from "./logger.js";
import { Runner } from "./runner.js";

/**
 * Ejecuta un turno del agente, parametrizado por el frontend. Es el núcleo del
 * seam: la MISMA lógica de turno maneja la TUI y el headless — sólo cambia el
 * `Frontend` que recibe los eventos. Lee ctx.session en cada turno (no una
 * captura del arranque) para que /resume, que reemplaza la sesión activa, aplique.
 */
export class TurnRunner {
  #core: CoreServices;
  #ctx: Context;
  #frontend: Frontend;

  constructor(core: CoreServices, ctx: Context, frontend: Frontend) {
    this.#core = core;
    this.#ctx = ctx;
    this.#frontend = frontend;
  }

  /** Modelo primario efectivo del turno (considera overrides de /model). */
  #resolvePrimaryModel(): string {
    return resolveAgentModel(
      "primary",
      getProfileByName(this.#ctx.session.profile)!,
      this.#ctx.session.modelOverrides as Record<string, string>,
    );
  }

  /** Classifier: fallback a su default resuelto (no al modelo primario). */
  #resolveClassifierModel(): string {
    return (
      this.#ctx.session.modelOverrides.classifier ?? this.#core.config.classifierModel
    );
  }

  async run(): Promise<void> {
    const { config, llmProvider, agentConfig, classifier } = this.#core;
    const frontend = this.#frontend;
    const session = this.#ctx.session;

    const abortController = new AbortController();
    frontend.setAbortController(abortController);

    const run = new Runner({
      llmProvider,
      agentConfig,
      maxSteps: config.maxSteps,
      maxContextTokens: config.maxContextTokens,
      signal: abortController.signal,
      model: this.#resolvePrimaryModel(),
      onAskUser: (question: string) => frontend.askUser(question),
    });

    // Aplicar overrides de /model para este turno (primary + classifier).
    agentConfig.setModel(this.#resolvePrimaryModel());
    classifier?.setModel(this.#resolveClassifierModel());

    try {
      frontend.turnStarted();
      for await (const event of run.run(session.getContext())) {
        if (event.type === "state") {
          session.addMessage(event.message);
        } else {
          frontend.handleEvent(event);
        }
      }
      frontend.turnEnded();
      session.compactWorkingContext();
    } catch (err: unknown) {
      frontend.turnEnded();
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Runner error", msg);
      frontend.notify(`Error: ${msg}`);
    } finally {
      frontend.clearAbortController();
    }

    const metrics = run.getMetrics();
    session.addUsage(
      metrics.totalInputTokens,
      metrics.totalOutputTokens,
      metrics.totalCost,
    );
    session.addStepUsage(run.getStepUsage().slice());

    // El core arma las métricas en crudo; cada frontend decide cómo mostrarlas
    // (la TUI dibuja la línea `~ ctx:`; el headless las emite estructuradas).
    frontend.reportMetrics({
      model: this.#resolvePrimaryModel(),
      steps: run.getStepUsage().length,
      contextTokens: session.contextTokens,
      toolCalls: metrics.totalToolCalls,
      inputTokens: metrics.totalInputTokens,
      outputTokens: metrics.totalOutputTokens,
      turnCost: metrics.totalCost,
      totalCost: session.totalCost,
      durationMs: metrics.durationMs,
      toolErrors: metrics.totalToolErrors,
      rereads: metrics.rereads,
    });
    run.resetMetrics();
  }
}
