import { AgentConfig } from "./agent-config.js";
import { truncate } from "./context-management.js";
import { logger } from "./logger.js";
import { Message, ToolMessage } from "./message.js";
import { LLMProvider, LLMResponse } from "./providers/llm-provider.js";

type RunnerConstructorProps = {
  llmProvider: LLMProvider;
  agentConfig: AgentConfig;
  maxSteps?: number;
};

type RunnerEvent =
  | { type: "text"; text: string }
  | { type: "state"; message: Message }
  | { type: "tool_use"; name: string; input: unknown }
  | {
      type: "tool_result";
      output: string;
    };

class Runner {
  #llmProvider: LLMProvider;
  #agentConfig: AgentConfig;
  #maxSteps: number;
  #metrics: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalToolCalls: number;
    startTime: number;
  };

  constructor({
    llmProvider,
    agentConfig,
    maxSteps = 15,
  }: RunnerConstructorProps) {
    this.#llmProvider = llmProvider;
    this.#agentConfig = agentConfig;
    this.#maxSteps = maxSteps;
    this.#metrics = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalToolCalls: 0,
      startTime: Date.now(),
    };
  }

  async *run(incomingContext: readonly Message[]): AsyncGenerator<RunnerEvent> {
    const workingContext = [...incomingContext];
    logger.info(`Starting runner with max steps: ${this.#maxSteps}`);

    let steps = this.#maxSteps;
    while (steps > 0) {
      const data: LLMResponse = await this.#llmProvider.call(
        workingContext,
        this.#agentConfig,
      );

      // Track tokens
      this.#metrics.totalInputTokens += data.usage.input_tokens;
      this.#metrics.totalOutputTokens += data.usage.output_tokens;
      logger.debug("Token usage", {
        input: data.usage.input_tokens,
        output: data.usage.output_tokens,
      });

      const assistantMessage: Message = {
        role: "assistant",
        content: data.content as Message["content"],
      };
      workingContext.push(assistantMessage);
      yield { type: "state", message: assistantMessage };

      const toolResults: ToolMessage[] = [];
      for (const block of data.content) {
        if (block.type === "text") {
          yield { type: "text", text: block.text };
        }
        if (block.type === "tool_use") {
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

          const shown = truncate(output, 200);

          yield { type: "tool_result", output: shown };
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: shown,
            is_error: isError,
          });
        }
      }

      if (toolResults.length > 0) {
        const toolMessage: Message = { role: "user", content: toolResults };
        workingContext.push(toolMessage);
        yield { type: "state", message: toolMessage };
      }

      if (data.stop_reason === "max_tokens") {
        logger.warn("Respuesta cortada por max_tokens");
        yield {
          type: "text",
          text: "⚠ La respuesta se cortó (max_tokens). Subí el límite o pedí algo más chico.",
        };
        break;
      }

      if (data.stop_reason === "end_turn") {
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
      startTime: Date.now(),
    };
  }
}

export { Runner };
