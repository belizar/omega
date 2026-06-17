import { AgentConfig } from "./agent-config.js";
import { pruneContext, truncateForContext, truncateForDisplay } from "./context-management.js";
import { logger } from "./logger.js";
import { Message, ToolMessage } from "./message.js";
import { LLMProvider, LLMResponse } from "./providers/llm-provider.js";

type RunnerConstructorProps = {
  llmProvider: LLMProvider;
  agentConfig: AgentConfig;
  maxSteps?: number;
  maxContextTokens?: number;
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
    };

class Runner {
  // Métricas de una sola corrida (se resetean con resetMetrics()).
  // El acumulado histórico lo mantiene Session (addUsage), que es el
  // único dueño persistente del costo total.
  #llmProvider: LLMProvider;
  #agentConfig: AgentConfig;
  #maxSteps: number;
  #maxContextTokens: number;
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
    maxSteps = 15,
    maxContextTokens = 100_000,
  }: RunnerConstructorProps) {
    this.#llmProvider = llmProvider;
    this.#agentConfig = agentConfig;
    this.#maxSteps = maxSteps;
    this.#maxContextTokens = maxContextTokens;
    this.#metrics = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalToolCalls: 0,
      totalCost: 0,
      startTime: Date.now(),
    };
  }

  async *run(incomingContext: readonly Message[]): AsyncGenerator<RunnerEvent> {
    const workingContext = [...incomingContext];
    logger.info(`Starting runner with max steps: ${this.#maxSteps}`);

    let steps = this.#maxSteps;
    while (steps > 0) {
      const prunedContext = pruneContext(workingContext, this.#maxContextTokens);

      // Usamos streaming si el provider lo soporta
      const hasStream = typeof this.#llmProvider.callStream === "function";
      const toolBlocks: Array<{ id: string; name: string; input: unknown }> = [];
      const textParts: string[] = [];
      let stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";

      if (hasStream) {
        const stream = this.#llmProvider.callStream(prunedContext, this.#agentConfig);

        for await (const event of stream) {
          if (event.type === "text") {
            textParts.push(event.text);
            yield { type: "text_stream", text: event.text };
          } else if (event.type === "tool_use") {
            toolBlocks.push({ id: event.id, name: event.name, input: event.input });
          } else if (event.type === "done") {
            stopReason = event.stop_reason;
            this.#metrics.totalInputTokens += event.usage.input_tokens;
            this.#metrics.totalOutputTokens += event.usage.output_tokens;
            this.#metrics.totalCost += event.cost;
          }
        }

        if (textParts.length > 0) {
          yield { type: "text_stream_end" };
        }
      } else {
        const data: LLMResponse = await this.#llmProvider.call(
          prunedContext,
          this.#agentConfig,
        );

        this.#metrics.totalInputTokens += data.usage.input_tokens;
        this.#metrics.totalOutputTokens += data.usage.output_tokens;
        this.#metrics.totalCost += data.cost;

        for (const block of data.content) {
          if (block.type === "text") {
            textParts.push(block.text);
            yield { type: "text", text: block.text };
          }
          if (block.type === "tool_use") {
            toolBlocks.push({ id: block.id, name: block.name, input: block.input });
          }
        }

        stopReason = data.stop_reason;
      }

      // Construir el mensaje assistant completo
      const assistantContent: Message["content"] = [];
      if (textParts.length > 0) {
        assistantContent.push({ type: "text", text: textParts.join("") });
      }
      for (const tb of toolBlocks) {
        assistantContent.push({
          type: "tool_use",
          id: tb.id,
          name: tb.name,
          input: tb.input,
        });
      }

      const assistantMessage: Message = {
        role: "assistant",
        content: assistantContent,
      };
      workingContext.push(assistantMessage);
      yield { type: "state", message: assistantMessage };

      // Ejecutar tools
      const toolResults: ToolMessage[] = [];
      for (const block of toolBlocks) {
        this.#metrics.totalToolCalls++;

        const tool = this.#agentConfig.getTool(block.name);
        if (!tool) {
          const output = `Error: unknown tool "${block.name}"`;
          logger.error(output);
          yield { type: "tool_result", output };
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: output,
            is_error: true,
          });
          continue;
        }

        yield { type: "tool_use", name: tool.name, input: block.input };

        let output: string;
        let isError = false;
        try {
          output = tool.execute(block.input) as string;
        } catch (err: unknown) {
          isError = true;
          output = `Error executing tool "${tool.name}": ${err instanceof Error ? err.message : String(err)}`;
          logger.error("Tool execution threw", {
            tool: tool.name,
            error: output,
          });
        }

        // Display: límite visual. Modelo: safety net por tokens.
        const shown = truncateForDisplay(output);
        const forModel = truncateForContext(output, this.#maxContextTokens);

        yield { type: "tool_result", output: shown, rawOutput: output };
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: forModel,
          is_error: isError,
        });
      }

      if (toolResults.length > 0) {
        const toolMessage: Message = { role: "user", content: toolResults };
        workingContext.push(toolMessage);
        yield { type: "state", message: toolMessage };
      }

      if (stopReason === "max_tokens") {
        logger.warn("Respuesta cortada por max_tokens");
        yield {
          type: "text",
          text: "⚠ La respuesta se cortó (max_tokens). Subí el límite o pedí algo más chico.",
        };
        break;
      }

      if (stopReason === "end_turn") {
        logger.info("Agent finished (end_turn)");
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

  resetMetrics() {
    this.#metrics = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalToolCalls: 0,
      totalCost: 0,
      startTime: Date.now(),
    };
  }
}

export { Runner, RunnerEvent };
