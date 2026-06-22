import { stdout } from "process";
import { AgentConfig } from "./agent-config.js";
import {
  pruneContext,
  truncateForContext,
  truncateForDisplay,
  rawWindow,
} from "./context-management.js";
import { Dossier } from "./dossier/dossier.js";
import type { DossierEvent } from "./dossier/types.js";
import { logger } from "./logger.js";
import { Message, ToolMessage } from "./message.js";
import { LLMProvider, LLMResponse } from "./providers/llm-provider.js";
import type { ToolResult } from "./tools/tool.js";

type RunnerConstructorProps = {
  llmProvider: LLMProvider;
  agentConfig: AgentConfig;
  dossier?: Dossier;
  convTurns?: number;
  maxSteps?: number;
  maxContextTokens?: number;
  signal?: AbortSignal;
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
  #interrupted: boolean;
  #onAskUser: ((question: string) => Promise<string>) | undefined;
  #dossier: Dossier | undefined;
  #convTurns: number;
  #stepUsage: Array<{ inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }>;
  #metrics: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalToolCalls: number;
    totalCost: number;
    startTime: number;
  };

  constructor({
    llmProvider,
    agentConfig,
    dossier,
    convTurns = 10,
    maxSteps = 15,
    maxContextTokens = 100_000,
    signal,
    onAskUser,
  }: RunnerConstructorProps) {
    this.#llmProvider = llmProvider;
    this.#agentConfig = agentConfig;
    this.#dossier = dossier;
    this.#convTurns = convTurns;
    this.#stepUsage = [];
    this.#maxSteps = maxSteps;
    this.#maxContextTokens = maxContextTokens;
    this.#signal = signal;
    this.#interrupted = false;
    this.#onAskUser = onAskUser;
    this.#metrics = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalToolCalls: 0,
      totalCost: 0,
      startTime: Date.now(),
    };
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
      const forModel = truncateForContext(result.output, this.#maxContextTokens);

      yield { type: "tool_result", output: shown, rawOutput: result.output };
      state.toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: forModel,
        is_error: result.isError,
      });
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
      const msg = `Error: unknown tool "${name}"`;
      logger.error(msg);
      return { output: msg, isError: true };
    }
    try {
      const raw = await tool.execute(input);
      // ToolResult (nuevo protocolo): extraer output y eventos
      if (raw && typeof raw === "object" && "output" in raw) {
        const tr = raw as ToolResult;
        if (tr.events && this.#dossier) {
          for (const event of tr.events) {
            this.#dossier.ingestEvent(event);
          }
        }
        return { output: tr.output, isError: false };
      }
      // Compatibilidad hacia atrás: string
      return { output: raw as string, isError: false };
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

      // Fold the dossier before each LLM call so the system prompt is fresh
      if (this.#dossier) {
        const { text } = this.#dossier.fold();
        this.#agentConfig.dossierFold = text;
      }

      // Windowing: con dossier activo, últimas K turnos de conversación + compactación de reads viejos.
      // Sin dossier, poda por tokens como siempre.
      const prunedContext = this.#dossier
        ? rawWindow(workingContext, this.#convTurns)
        : pruneContext(workingContext, this.#maxContextTokens);

      const state = this.#newTurnState();

      try {
        yield* this.#callLLM(prunedContext, state);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
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
        throw err;
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
      }

      if (state.stopReason === "max_tokens") {
        logger.warn("Respuesta cortada por max_tokens");
        yield {
          type: "text",
          text: "⚠ La respuesta se cortó (max_tokens). Subí el límite o pedí algo más chico.",
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
    return {
      ...this.#metrics,
      durationMs: Date.now() - this.#metrics.startTime,
    };
  }

  getStepUsage(): ReadonlyArray<{
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cost: number;
  }> {
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
  }
}

export { Runner, RunnerEvent };
