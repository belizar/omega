import { stdout } from "process";
import { AgentConfig } from "./agent-config.js";
import {
  compactStaleReads,
  pruneContext,
  truncateForContext,
  truncateForDisplay,
} from "./context-management.js";
import { logger } from "./logger.js";
import { Message, ToolMessage } from "./message.js";
import { LLMProvider, LLMResponse } from "./providers/llm-provider.js";

/** Cap absoluto de tokens que un solo tool_result puede aportar al contexto.
 *  Suficiente para que el agente extraiga lo que necesita; los volcados crudos
 *  gigantes (queries, dumps) se truncan head+tail y se re-consultan si hace falta. */
const MAX_TOOL_RESULT_TOKENS = 12_000;

type RunnerConstructorProps = {
  llmProvider: LLMProvider;
  agentConfig: AgentConfig;
  maxSteps?: number;
  maxContextTokens?: number;
  signal?: AbortSignal;
  /** Modelo activo para este turno (se guarda en stepUsage para trazabilidad). */
  model?: string;
  /** Si se provee, las invocaciones a la tool `ask_user` pausan el runner
   * y llaman a este callback. La respuesta se inyecta como tool_result. */
  onAskUser?: (question: string) => Promise<string>;
};

type RunnerEvent =
  | { type: "text"; text: string }
  | { type: "text_stream"; text: string }
  | { type: "text_stream_end" }
  | { type: "state"; message: Message }
  | { type: "tool_use"; name: string; input: unknown }
  | {
      type: "tool_result";
      output: string;
      /** Output completo (sin truncar) para poder mostrar un resumen real. */
      rawOutput?: string;
      /** La tool falló → se renderiza en rojo (señal de error, §2). */
      isError?: boolean;
    }
  | { type: "ask_user"; question: string; toolId: string };

/** Estado mutable que comparten los métodos de un turno del loop. */
interface TurnState {
  textParts: string[];
  toolBlocks: Array<{ id: string; name: string; input: unknown }>;
  toolResults: ToolMessage[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

class Runner {
  // Métricas de una sola corrida (se resetean con resetMetrics()).
  // El acumulado histórico lo mantiene Session (addUsage), que es el
  // único dueño persistente del costo total.
  #llmProvider: LLMProvider;
  #agentConfig: AgentConfig;
  #maxSteps: number;
  #maxContextTokens: number;
  #signal: AbortSignal | undefined;
  #model: string;
  #interrupted: boolean;
  #onAskUser: ((question: string) => Promise<string>) | undefined;
  #metrics: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalToolCalls: number;
    totalCost: number;
    startTime: number;
  };
  #stepUsage: Array<{
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cost: number;
    model?: string;
  }>;

  // ── Detección de loops ──
  #consecutiveErrors = 0;

  // ── Métricas anti-thrashing (consultables con /stats) ──
  #readCounts = new Map<string, number>();
  #editCounts = new Map<string, number>();
  #totalToolErrors = 0;

  constructor({
    llmProvider,
    agentConfig,
    maxSteps = 15,
    maxContextTokens = 100_000,
    signal,
    model,
    onAskUser,
  }: RunnerConstructorProps) {
    this.#llmProvider = llmProvider;
    this.#agentConfig = agentConfig;
    this.#maxSteps = maxSteps;
    this.#maxContextTokens = maxContextTokens;
    this.#signal = signal;
    this.#model = model ?? "";
    this.#interrupted = false;
    this.#onAskUser = onAskUser;
    this.#metrics = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalToolCalls: 0,
      totalCost: 0,
      startTime: Date.now(),
    };
    this.#stepUsage = [];
  }

  /** Expone si el runner fue interrumpido (SIGINT) — el caller lo usa para
   * saber si debe guardar métricas parciales o descartarlas. */
  get interrupted(): boolean {
    return this.#interrupted;
  }

  // ── helpers ────────────────────────────────────────────────────────

  /**
   * Arma el contenido del mensaje assistant a partir de lo producido
   * en el turno. Si no hay nada visible, pone un fallback.
   */
  #buildAssistantContent(state: TurnState): Message["content"] {
    const content: Message["content"] = [];
    if (state.textParts.length > 0) {
      content.push({ type: "text", text: state.textParts.join("") });
    }
    for (const tb of state.toolBlocks) {
      content.push({
        type: "tool_use",
        id: tb.id,
        name: tb.name,
        input: tb.input,
      });
    }
    if (content.length === 0) {
      content.push({
        type: "text",
        text: "(El modelo no produjo contenido visible en este turno)",
      });
    }
    return content;
  }

  /** Construye el snapshot del estado vacío para un turno nuevo. */
  #newTurnState(): TurnState {
    return {
      textParts: [],
      toolBlocks: [],
      toolResults: [],
      stopReason: "end_turn",
    };
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Backoff exponencial con tope: 400ms, 800ms, 1600ms… hasta 4s. */
  #backoffMs(attempt: number): number {
    return Math.min(400 * 2 ** (attempt - 1), 4000);
  }

  /** True si el error es transitorio (red / gateway) y vale la pena reintentar.
   *  NO reintenta AbortError (interrupción del usuario) ni errores de lógica. */
  #isRetryableError(err: unknown): boolean {
    if (err instanceof Error && err.name === "AbortError") return false;
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (
      msg.includes("fetch failed") ||
      msg.includes("econnreset") ||
      msg.includes("socket hang up") ||
      msg.includes("etimedout") ||
      msg.includes("eai_again") ||
      msg.includes("enotfound") ||
      msg.includes("network") ||
      msg.includes("terminated") ||
      msg.includes("timeout") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504") ||
      msg.includes("529")
    );
  }

  // ── fases del turno ────────────────────────────────────────────────

  /** Llama al LLM (stream o no-stream), emite eventos y llena `state`. */
  async *#callLLM(
    prunedContext: Message[],
    state: TurnState,
  ): AsyncGenerator<RunnerEvent> {
    const hasStream = typeof this.#llmProvider.callStream === "function";

    if (hasStream) {
      const stream = this.#llmProvider.callStream(
        prunedContext,
        this.#agentConfig,
        this.#signal,
      );

      for await (const event of stream) {
        if (event.type === "text") {
          state.textParts.push(event.text);
          yield { type: "text_stream", text: event.text };
        } else if (event.type === "tool_use") {
          state.toolBlocks.push({
            id: event.id,
            name: event.name,
            input: event.input,
          });
        } else if (event.type === "done") {
          state.stopReason = event.stop_reason;
          this.#metrics.totalInputTokens += event.usage.input_tokens;
          this.#metrics.totalOutputTokens += event.usage.output_tokens;
          this.#metrics.totalCost += event.cost;
          this.#stepUsage.push({
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
            cachedTokens: event.usage.cached_tokens ?? 0,
            cost: event.cost,
            model: this.#model || undefined,
          });
        }
      }

      if (state.textParts.length > 0) {
        yield { type: "text_stream_end" };
      }
    } else {
      const data: LLMResponse = await this.#llmProvider.call(
        prunedContext,
        this.#agentConfig,
        this.#signal,
      );

      this.#metrics.totalInputTokens += data.usage.input_tokens;
      this.#metrics.totalOutputTokens += data.usage.output_tokens;
      this.#metrics.totalCost += data.cost;
      this.#stepUsage.push({
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        cachedTokens: data.usage.cached_tokens ?? 0,
        cost: data.cost,
        model: this.#model || undefined,
      });

      for (const block of data.content) {
        if (block.type === "text") {
          state.textParts.push(block.text);
          yield { type: "text", text: block.text };
        }
        if (block.type === "tool_use") {
          state.toolBlocks.push({
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }

      state.stopReason = data.stop_reason;
    }
  }

  /** Ejecuta las tool calls pendientes, emite eventos y llena `state.toolResults`.
   *
   * Las tools regulares se ejecutan en paralelo (Promise.allSettled).
   * Los tool_use se emiten todos primero; los tool_result se emiten en
   * el orden original de los tool_use, preservando consistencia.
   * ask_user se ejecuta siempre secuencial. */
  async *#executeTools(state: TurnState): AsyncGenerator<RunnerEvent> {
    // 1. Separar ask_user del resto y emitir tool_use en orden
    for (const block of state.toolBlocks) {
      yield { type: "tool_use", name: block.name, input: block.input };
    }

    // 2. Lanzar tools regulares en paralelo (sin esperar aún)
    const regularBlocks = state.toolBlocks.filter((b) => b.name !== "ask_user");
    this.#metrics.totalToolCalls += regularBlocks.length;

    const pending = new Map(
      regularBlocks.map((block) => {
        const promise = this.#executeOneTool(block.name, block.id, block.input);
        return [block.id, promise];
      }),
    );

    // 3. Procesar en orden original: ask_user secuencial, tools resueltas
    for (const block of state.toolBlocks) {
      if (block.name === "ask_user") {
        yield* this.#handleAskUser(block, state);
        continue;
      }

      const result = await pending.get(block.id)!;
      const shown = truncateForDisplay(result.output);
      // Cap ABSOLUTO por result (no un % del presupuesto): un volcado gigante
      // de una query no tiene por qué ocupar 100k+ tokens y expulsar la
      // conversación. Si el agente necesita más, re-consulta / pagina.
      const forModel = truncateForContext(result.output, MAX_TOOL_RESULT_TOKENS, 1);

      yield { type: "tool_result", output: shown, rawOutput: result.output, isError: result.isError };
      state.toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: forModel,
        is_error: result.isError,
      });

      // ── Métricas anti-thrashing ──
      if (result.isError) {
        this.#totalToolErrors++;
      }
      const input = block.input as { path?: string } | null;
      if (input?.path) {
        if (block.name === "read") {
          this.#readCounts.set(
            input.path,
            (this.#readCounts.get(input.path) ?? 0) + 1,
          );
        } else if (block.name === "edit" || block.name === "write") {
          this.#editCounts.set(
            input.path,
            (this.#editCounts.get(input.path) ?? 0) + 1,
          );
        }
      }
    }
  }

  /** Ejecuta una sola tool y devuelve output + flag de error. */
  async #executeOneTool(
    name: string,
    id: string,
    input: unknown,
  ): Promise<{ output: string; isError: boolean }> {
    const tool = this.#agentConfig.getTool(name);
    if (!tool) {
      const msg =
        `Error: tool desconocida "${name}".\n` +
        `Si necesitás una tool que no está entre las esenciales (read, write, edit, bash, grep, outline, ask_user, tool_search), ` +
        `usá tool_search para buscarla.`;
      logger.error(`Unknown tool "${name}"`);
      return { output: msg, isError: true };
    }
    try {
      return { output: (await tool.execute(input)) as string, isError: false };
    } catch (err: unknown) {
      const msg = `Error executing tool "${name}": ${err instanceof Error ? err.message : String(err)}`;
      logger.error("Tool execution threw", { tool: name, error: msg });
      return { output: msg, isError: true };
    }
  }

  // ── sub-fases de executeTools ──────────────────────────────────────

  async *#handleAskUser(
    block: { id: string; name: string; input: unknown },
    state: TurnState,
  ): AsyncGenerator<RunnerEvent> {
    if (!this.#onAskUser) return;

    const question =
      (block.input as { question?: string }).question ?? "¿Continuar?";
    yield { type: "ask_user", question, toolId: block.id };

    const answer = await this.#onAskUser(question);
    const output = answer || "(sin respuesta)";
    yield {
      type: "tool_result",
      output: "(confirmación recibida)",
      rawOutput: output,
    };
    state.toolResults.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: output,
      is_error: false,
    });
  }

  // ── loop principal ─────────────────────────────────────────────────

  async *run(incomingContext: readonly Message[]): AsyncGenerator<RunnerEvent> {
    const workingContext = [...incomingContext];
    logger.info(`Starting runner with max steps: ${this.#maxSteps}`);

    let steps = this.#maxSteps;
    while (steps > 0) {
      if (this.#signal?.aborted) {
        this.#interrupted = true;
        logger.info("Runner interrupted by abort signal");
        yield { type: "text", text: "⏹ Interrumpido por el usuario." };
        break;
      }

      // Compactar reads viejos antes de podar: reduce tokens sin perder info
      const compactedContext = compactStaleReads(workingContext);
      const prunedContext = pruneContext(
        compactedContext,
        this.#maxContextTokens,
      );

      // ── Llamada al LLM con reintentos ────────────────────────────────
      // Una completion vacía (sin texto ni tool calls) o un error de red
      // transitorio NO son un "fin de turno" — antes el harness los trataba
      // como end_turn y frenaba, obligando al usuario a tipear "?".
      // Reintentamos sobre el MISMO contexto (cache-friendly) con backoff.
      const MAX_LLM_RETRIES = 3;
      let state = this.#newTurnState();
      let llmAborted = false;
      let attempt = 0;

      while (true) {
        attempt++;
        state = this.#newTurnState();

        try {
          yield* this.#callLLM(prunedContext, state);
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AbortError") {
            llmAborted = true;
            break;
          }
          if (this.#isRetryableError(err) && attempt <= MAX_LLM_RETRIES) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(
              `LLM network error, retrying (${attempt}/${MAX_LLM_RETRIES})`,
              { error: msg },
            );
            yield {
              type: "text",
              text: `⟳ Error de red, reintentando (${attempt}/${MAX_LLM_RETRIES})…`,
            };
            await this.#sleep(this.#backoffMs(attempt));
            continue;
          }
          throw err;
        }

        // Turno degenerado: ni texto ni tool calls. Completion vacía del
        // modelo o stream cortado sin `done`. Indistinguible de end_turn,
        // así que lo reintentamos en vez de darlo por terminado.
        const empty =
          state.textParts.length === 0 && state.toolBlocks.length === 0;
        if (empty && attempt <= MAX_LLM_RETRIES) {
          logger.warn(`Empty completion, retrying (${attempt}/${MAX_LLM_RETRIES})`);
          yield {
            type: "text",
            text: `⟳ Respuesta vacía, reintentando (${attempt}/${MAX_LLM_RETRIES})…`,
          };
          await this.#sleep(this.#backoffMs(attempt));
          continue;
        }
        break;
      }

      if (llmAborted) {
        this.#interrupted = true;
        logger.info("LLM call aborted by signal");
        yield { type: "text", text: "⏹ Interrumpido por el usuario." };
        const partialMessage: Message = {
          role: "assistant",
          content: this.#buildAssistantContent(state),
        };
        workingContext.push(partialMessage);
        yield { type: "state", message: partialMessage };
        break;
      }

      // Si tras los reintentos sigue vacío, avisamos claro y cortamos —
      // en vez del placeholder mudo que obligaba a tipear "?".
      const stillEmpty =
        state.textParts.length === 0 && state.toolBlocks.length === 0;
      if (stillEmpty) {
        logger.warn("Empty completion persisted after retries");
        yield {
          type: "text",
          text: "⚠ El modelo devolvió respuestas vacías repetidas (posible corte de red o contexto muy grande). Probá de nuevo, o cambiá de modelo con /model primary <modelo>.",
        };
        break;
      }

      // Agregar mensaje assistant al contexto
      const assistantMessage: Message = {
        role: "assistant",
        content: this.#buildAssistantContent(state),
      };
      workingContext.push(assistantMessage);
      yield { type: "state", message: assistantMessage };

      // Ejecutar tools
      yield* this.#executeTools(state);

      if (state.toolResults.length > 0) {
        const toolMessage: Message = {
          role: "user",
          content: state.toolResults,
        };
        workingContext.push(toolMessage);
        yield { type: "state", message: toolMessage };

        // ── Detección de loops por errores consecutivos ──
        const hasError = state.toolResults.some((r) => r.is_error);
        if (hasError) {
          this.#consecutiveErrors++;
          if (this.#consecutiveErrors >= 3) {
            const warning =
              "⚠ 3 errores consecutivos en tools. ¿Podés cambiar de estrategia? " +
              "Si no sabés cómo resolverlo, usá ask_user para pedirle ayuda al usuario.";
            logger.warn("Consecutive tool errors", {
              count: this.#consecutiveErrors,
            });
            yield { type: "text", text: warning };
            workingContext.push({
              role: "user",
              content: [{ type: "text", text: warning }],
            });
            this.#consecutiveErrors = 0;
          }
        } else {
          this.#consecutiveErrors = 0;
        }
      }

      // ── Auto-continuación ────────────────────────────────────
      // Si el LLM se corta por max_tokens, mandamos un "Continue"
      // automático (hasta 2 veces) en vez de frenar.
      const MAX_AUTO_CONTINUES = 2;
      let continueCount = 0;

      if (state.stopReason === "max_tokens") {
        continueCount++;
        if (continueCount <= MAX_AUTO_CONTINUES) {
          logger.info(
            `Auto-continuing after max_tokens (${continueCount}/${MAX_AUTO_CONTINUES})`,
          );
          yield { type: "text", text: "⏳ Continuando..." };
          workingContext.push({
            role: "user",
            content: [
              {
                type: "text",
                text: "Continue from where you left off.",
              },
            ],
          });
          continue; // no consume step, vuelve al loop
        }

        logger.warn("Max auto-continues reached");
        yield {
          type: "text",
          text: "⚠ Límite de auto-continuaciones alcanzado. La respuesta quedó incompleta.",
        };
        break;
      }

      if (state.stopReason === "end_turn") {
        logger.info("Agent finished (end_turn)");
        break;
      }

      // Si el provider devolvió "tool_use" pero no había tools que ejecutar
      // (respuesta de texto puro con stop_reason incorrecto), cortamos.
      if (state.stopReason === "tool_use" && state.toolResults.length === 0) {
        logger.info("Agent finished (tool_use without tools)");
        break;
      }

      steps--;
      if (steps === 0) {
        logger.warn(`Max steps reached (${this.#maxSteps})`);
      }
    }
  }

  getMetrics() {
    // Re-lecturas: archivos leídos más de una vez
    const rereads = [...this.#readCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([path, count]) => ({ path, count }));

    return {
      ...this.#metrics,
      durationMs: Date.now() - this.#metrics.startTime,
      // Métricas anti-thrashing (consultables, no se muestran por defecto)
      readsByFile: Object.fromEntries(this.#readCounts),
      editsByFile: Object.fromEntries(this.#editCounts),
      rereads,
      totalToolErrors: this.#totalToolErrors,
    };
  }

  getStepUsage(): readonly {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cost: number;
  }[] {
    return this.#stepUsage;
  }

  resetMetrics() {
    this.#metrics = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalToolCalls: 0,
      totalCost: 0,
      startTime: Date.now(),
    };
    this.#stepUsage = [];
    this.#readCounts = new Map();
    this.#editCounts = new Map();
    this.#totalToolErrors = 0;
    this.#consecutiveErrors = 0;
  }
}

export { Runner, RunnerEvent };
