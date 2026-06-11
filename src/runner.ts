import { AgentConfig } from "./agent-config.js";
import { Message, ToolMessage } from "./message.js";
import { LLMProvider } from "./providers/llm-provider.js";
import { logger } from "./logger.js";

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

  constructor({ llmProvider, agentConfig, maxSteps = 15 }: RunnerConstructorProps) {
    this.#llmProvider = llmProvider;
    this.#agentConfig = agentConfig;
    this.#maxSteps = maxSteps;
  }

  async *run(incomingContext: readonly Message[]): AsyncGenerator<RunnerEvent> {
    const workingContext = [...incomingContext];
    logger.info(`Starting runner with max steps: ${this.#maxSteps}`);

    let steps = this.#maxSteps;
    while (steps > 0) {
      const data: any = await this.#llmProvider.call(
        workingContext,
        this.#agentConfig,
      );

      const assistantMessage: Message = {
        role: "assistant",
        content: data.content,
      };
      workingContext.push(assistantMessage);
      yield { type: "state", message: assistantMessage };

      const toolResults: ToolMessage[] = [];
      for (const block of data.content) {
        if (block.type === "text") {
          yield { type: "text", text: block.text };
        }
        if (block.type === "tool_use") {
          const tool = this.#agentConfig.getTool(block.name);
          yield { type: "text", text: `Usando tool: ${tool.name}` };
          const toolResult = tool.execute(block.input);
          yield { type: "tool_result", output: toolResult as string };
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: toolResult,
            is_error: false,
          });
        }
      }

      if (toolResults.length > 0) {
        const toolMessage: Message = { role: "user", content: toolResults };
        workingContext.push(toolMessage);
        yield { type: "state", message: toolMessage };
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
}

export { Runner };
